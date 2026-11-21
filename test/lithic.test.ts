import { test } from "node:test";
import assert from "node:assert/strict";
import { createLithicIssuing, lithicFromEnv } from "../lib/lithic.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function fakeFetch(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: String(init?.method), headers: init?.headers as Record<string, string>, body: String(init?.body ?? "") });
    const r = responses.shift();
    if (!r) throw new Error("nessuna risposta finta");
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  };
  return { fn, calls };
}

const CARD = { token: "card-1", last_four: "4242", exp_month: "08", exp_year: "2031", state: "OPEN", pan: "4111111111114242" };
const TX = { token: "tx-1", result: "APPROVED", amount: 4200, created: "2026-11-21T10:00:00Z", card_token: "card-1", merchant: { descriptor: "TAXI TORINO", city: "Torino", mcc: "4121" } };
const sim = { cardId: "card-1", amountCents: 4200, merchantName: "TAXI TORINO", merchantCategory: "taxicabs_limousines", merchantCity: "Torino", idempotencyKey: "pay-R1" };

test("base URL di produzione rifiutata, env mancante = null", () => {
  assert.throws(() => createLithicIssuing("k", fetch, "https://api.lithic.com"), /sandbox/);
  const old = process.env.LITHIC_API_KEY;
  delete process.env.LITHIC_API_KEY;
  assert.equal(lithicFromEnv(), null);
  process.env.LITHIC_API_KEY = "k";
  assert.ok(lithicFromEnv());
  if (old === undefined) delete process.env.LITHIC_API_KEY; else process.env.LITHIC_API_KEY = old;
});

test("ensureCardholder: nessuna rete", async () => {
  const { fn, calls } = fakeFetch([]);
  const s = createLithicIssuing("k", fn);
  assert.equal(await s.ensureCardholder({ userId: "u1", name: "A B", email: "a@x.it", existingId: null }), "lithic-holder-u1");
  assert.equal(await s.ensureCardholder({ userId: "u1", name: "A B", email: "a@x.it", existingId: "old" }), "old");
  assert.equal(calls.length, 0);
});

test("createCard: auth, body, stato, regola best effort", async () => {
  const { fn, calls } = fakeFetch([{ json: CARD }, { json: { token: "rule-1" } }, { json: {} }]);
  const s = createLithicIssuing("chiave-segreta", fn);
  const card = await s.createCard({ requestId: "R1", cardholderId: "h", limitCents: 4200, allowedCategories: ["taxicabs_limousines"] });
  assert.deepEqual(card, { id: "card-1", last4: "4242", expMonth: 8, expYear: 2031, status: "active" });
  assert.equal(calls[0].url, "https://sandbox.lithic.com/v1/cards");
  assert.equal(calls[0].headers.authorization, "chiave-segreta");
  assert.ok(calls[0].headers["idempotency-key"]);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.type, "SINGLE_USE");
  assert.equal(body.spend_limit, 4200);
  assert.equal(body.spend_limit_duration, "TRANSACTION");
  assert.equal(body.memo, "R1");
  assert.deepEqual(JSON.parse(calls[1].body).card_tokens, ["card-1"]);
  assert.ok(calls[2].url.endsWith("/v2/auth_rules/rule-1/promote"));
  assert.ok(!JSON.stringify(card).includes("4111"));
});

test("createCard non fallisce se la auth rule fallisce; stati mappati", async () => {
  const { fn } = fakeFetch([{ json: { ...CARD, state: "PAUSED" } }, { status: 403, json: { message: "no" } }]);
  const card = await createLithicIssuing("k", fn).createCard({ requestId: "R2", cardholderId: "h", limitCents: 100, allowedCategories: ["railroads"] });
  assert.equal(card.status, "inactive");
  const { fn: fn2 } = fakeFetch([{ json: { ...CARD, state: "CLOSED" } }]);
  assert.equal((await createLithicIssuing("k", fn2).createCard({ requestId: "R3", cardholderId: "h", limitCents: 100, allowedCategories: [] })).status, "canceled");
});

test("deactivateCard: PATCH PAUSED; errore senza chiave", async () => {
  const { fn, calls } = fakeFetch([{ json: {} }, { status: 400, json: { message: "Bad card" } }]);
  const s = createLithicIssuing("chiave-segreta", fn);
  await s.deactivateCard("card-1");
  assert.equal(calls[0].method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].body), { state: "PAUSED" });
  await assert.rejects(s.deactivateCard("card-1"), (e: Error) => /Lithic 400 \(PATCH \/v1\/cards\/card-1\): Bad card/.test(e.message) && !e.message.includes("chiave-segreta"));
});

test("simulatePayment approvato: authorize -> clearing, idempotente", async () => {
  const { fn, calls } = fakeFetch([
    { json: CARD }, { json: { token: "rule-1" } }, { json: {} },
    { json: { token: "tx-1" } }, { json: { ...TX, result: "APPROVED" } }, { json: {} }, { json: TX },
  ]);
  const s = createLithicIssuing("k", fn);
  await s.createCard({ requestId: "R1", cardholderId: "h", limitCents: 4200, allowedCategories: ["taxicabs_limousines"] });
  const r = await s.simulatePayment(sim);
  assert.ok(r.approved);
  if (r.approved) {
    assert.equal(r.transaction.id, "tx-1");
    assert.equal(r.transaction.amountCents, 4200);
    assert.equal(r.transaction.merchantCategory, "taxicabs_limousines");
    assert.equal(r.transaction.merchantCity, "Torino");
    assert.equal(r.transaction.createdIso, "2026-11-21T10:00:00.000Z");
  }
  const a = JSON.parse(calls[3].body);
  assert.equal(a.pan, "4111111111114242");
  assert.equal(a.amount, 4200);
  assert.equal(a.mcc, "4121");
  assert.equal(a.descriptor, "TAXI TORINO");
  assert.ok(calls[5].url.endsWith("/v1/simulate/clearing"));
  assert.deepEqual(JSON.parse(calls[5].body), { token: "tx-1", amount: 4200 });
  const n = calls.length;
  assert.deepEqual(await s.simulatePayment(sim), r);
  assert.equal(calls.length, n);
});

test("simulatePayment rifiutato oltre il limite", async () => {
  const { fn, calls } = fakeFetch([
    { json: { ...CARD, state: "OPEN" } },
    { json: { token: "tx-2" } }, { json: { token: "tx-2", result: "USER_TRANSACTION_LIMIT" } },
  ]);
  const s = createLithicIssuing("k", fn);
  await s.createCard({ requestId: "R1", cardholderId: "h", limitCents: 4200, allowedCategories: [] });
  const r = await s.simulatePayment({ ...sim, amountCents: 5000 });
  assert.deepEqual(r, { approved: false, authorizationId: "tx-2", reason: "USER_TRANSACTION_LIMIT" });
  assert.equal(calls.length, 3);
});

test("simulatePayment: MCC non ammesso rifiutato senza rete; PAN riletto se ignoto", async () => {
  const { fn, calls } = fakeFetch([{ json: CARD }, { status: 500, json: {} }, { json: { token: "tx-3" } }, { json: { token: "tx-3", result: "APPROVED" } }, { json: {} }, { json: TX }]);
  const s = createLithicIssuing("k", fn);
  await s.createCard({ requestId: "R1", cardholderId: "h", limitCents: 4200, allowedCategories: ["taxicabs_limousines"] });
  const r = await s.simulatePayment({ ...sim, merchantCategory: "eating_places_restaurants", idempotencyKey: "pay-x" });
  assert.deepEqual(r, { approved: false, authorizationId: "local-pay-x", reason: "MERCHANT_CATEGORY_NOT_ALLOWED" });
  assert.equal(calls.length, 2);
  const s2 = createLithicIssuing("k", fakeFetch([{ json: CARD }, { json: { token: "t" } }, { json: { token: "t", result: "APPROVED" } }, { json: {} }, { json: TX }]).fn);
  const r2 = await s2.simulatePayment(sim);
  assert.ok(r2.approved);
});
