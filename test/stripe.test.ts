import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  createStripeIssuing, encodeForm, stripeFromEnv, transactionFromStripe, verifyWebhook,
} from "../lib/stripe.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function fakeFetch(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: String(init?.method), headers: init?.headers as Record<string, string>, body: String(init?.body ?? "") });
    const r = responses.shift();
    if (!r) throw new Error("nessuna risposta finta");
    const status = r.status ?? 200;
    return new Response(JSON.stringify(r.json), { status });
  };
  return { fn, calls };
}

const TX = {
  id: "ipi_1", card: "ic_1", authorization: "iauth_1", amount: -4200, created: 1700000000,
  merchant_data: { name: "TAXI TORINO", category: "taxicabs_limousines", city: "Torino" },
};

test("encodeForm: parentesi, array, null ignorati", () => {
  const s = decodeURIComponent(encodeForm({
    a: 1,
    spending_controls: { spending_limits: [{ amount: 4200, interval: "all_time" }], allowed_categories: ["x", "y"] },
    metadata: { request_id: "r 1" }, skip: undefined, nul: null,
  }));
  assert.equal(s, "a=1&spending_controls[spending_limits][0][amount]=4200&spending_controls[spending_limits][0][interval]=all_time&spending_controls[allowed_categories][]=x&spending_controls[allowed_categories][]=y&metadata[request_id]=r 1");
});

test("chiavi live rifiutate, env mancante = null", () => {
  assert.throws(() => createStripeIssuing("sk_live_abc"), /sk_test_/);
  const old = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(stripeFromEnv(), null);
  process.env.STRIPE_SECRET_KEY = "sk_live_abc";
  assert.throws(() => stripeFromEnv(), /sk_test_/);
  if (old === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = old;
});

test("createCard: body, idempotenza, header", async () => {
  const { fn, calls } = fakeFetch([{ json: { id: "ic_1", last4: "4242", exp_month: 8, exp_year: 2029, status: "active" } }]);
  const s = createStripeIssuing("sk_test_x", fn);
  const card = await s.createCard({ requestId: "R1", cardholderId: "ich_1", limitCents: 4200, allowedCategories: ["taxicabs_limousines"] });
  assert.deepEqual(card, { id: "ic_1", last4: "4242", expMonth: 8, expYear: 2029, status: "active" });
  const c = calls[0];
  assert.equal(c.url, "https://api.stripe.com/v1/issuing/cards");
  assert.equal(c.headers["idempotency-key"], "card-R1");
  assert.equal(c.headers.authorization, "Bearer sk_test_x");
  assert.ok(c.headers["stripe-version"]);
  const body = decodeURIComponent(c.body);
  for (const part of ["currency=eur", "type=virtual", "status=active", "spending_controls[spending_limits][0][amount]=4200", "spending_controls[spending_limits][0][interval]=all_time", "spending_controls[allowed_categories][]=taxicabs_limousines", "metadata[request_id]=R1"]) {
    assert.ok(body.includes(part), part);
  }
});

test("ensureCardholder: riusa existingId, altrimenti crea", async () => {
  const { fn, calls } = fakeFetch([{ json: { id: "ich_9", requirements: { past_due: [] } } }]);
  const s = createStripeIssuing("sk_test_x", fn);
  assert.equal(await s.ensureCardholder({ userId: "u1", name: "Anna Rossi", email: "a@x.it", existingId: "ich_old" }), "ich_old");
  assert.equal(calls.length, 0);
  assert.equal(await s.ensureCardholder({ userId: "u1", name: "Anna Rossi", email: "a@x.it", existingId: null }), "ich_9");
  const body = decodeURIComponent(calls[0].body);
  assert.ok(body.includes("individual[first_name]=Anna") && body.includes("individual[last_name]=Rossi"));
  assert.ok(body.includes("billing[address][country]=IT") && body.includes("billing[address][city]=Torino"));
  assert.equal(calls[0].headers["idempotency-key"], "cardholder-u1");
});

test("errore Stripe: messaggio senza chiave", async () => {
  const { fn } = fakeFetch([{ status: 400, json: { error: { message: "Invalid card" } } }]);
  const s = createStripeIssuing("sk_test_segreta", fn);
  await assert.rejects(s.deactivateCard("ic_1"), (e: Error) => /Invalid card/.test(e.message) && !e.message.includes("sk_test_segreta"));
});

const sim = { cardId: "ic_1", amountCents: 4200, merchantName: "TAXI TORINO", merchantCategory: "taxicabs_limousines", merchantCity: "Torino", idempotencyKey: "pay-R1" };

test("simulatePayment approvato", async () => {
  const { fn, calls } = fakeFetch([
    { json: { id: "iauth_1", approved: true, status: "pending", transactions: [] } },
    { json: { id: "iauth_1", approved: true, transactions: [TX] } },
  ]);
  const r = await createStripeIssuing("sk_test_x", fn).simulatePayment(sim);
  assert.ok(r.approved);
  if (r.approved) {
    assert.equal(r.transaction.amountCents, 4200);
    assert.equal(r.transaction.merchantCity, "Torino");
  }
  assert.ok(calls[1].url.endsWith("/test_helpers/issuing/authorizations/iauth_1/capture"));
  assert.equal(calls[0].headers["idempotency-key"], "pay-R1-auth");
});

test("simulatePayment rifiutato con motivo", async () => {
  const { fn, calls } = fakeFetch([
    { json: { id: "iauth_2", approved: false, status: "closed", request_history: [{ reason: "spending_controls" }] } },
  ]);
  const r = await createStripeIssuing("sk_test_x", fn).simulatePayment({ ...sim, amountCents: 5000 });
  assert.deepEqual(r, { approved: false, authorizationId: "iauth_2", reason: "spending_controls" });
  assert.equal(calls.length, 1);
});

test("transactionFromStripe: importo assoluto", () => {
  const t = transactionFromStripe(TX);
  assert.equal(t.amountCents, 4200);
  assert.equal(t.cardId, "ic_1");
  assert.equal(t.authorizationId, "iauth_1");
  assert.equal(t.createdIso, "2023-11-14T22:13:20.000Z");
  assert.throws(() => transactionFromStripe({}));
});

test("verifyWebhook: valida, non valida, scaduta", () => {
  const secret = "whsec_test";
  const payload = JSON.stringify({ type: "issuing_transaction.created" });
  const sign = (t: number, p = payload, s = secret) => `t=${t},v1=${createHmac("sha256", s).update(`${t}.${p}`).digest("hex")}`;
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual(verifyWebhook(payload, sign(now), secret), { type: "issuing_transaction.created" });
  assert.throws(() => verifyWebhook(payload, sign(now, payload, "altro"), secret), /non valida/);
  assert.throws(() => verifyWebhook(payload + " ", sign(now), secret), /non valida/);
  assert.throws(() => verifyWebhook(payload, sign(now - 1000), secret), /scaduta/);
  assert.throws(() => verifyWebhook(payload, null, secret), /mancante/);
  assert.throws(() => verifyWebhook(payload, "garbage", secret), /malformata/);
});
