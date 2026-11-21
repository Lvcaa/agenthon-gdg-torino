import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { agentTurn, type Llm } from "../lib/agent.ts";
import { COMPANY_BILLING } from "../lib/categories.ts";
import { DEMO_USERS, openDatabase } from "../lib/db.ts";
import {
  DOCUMENT_DEADLINE_DAYS,
  FlowError,
  assertCanAttach,
  attachDocument,
  attachReceipt,
  cardView,
  confirmProposal,
  decide,
  exportCsv,
  financeApprove,
  issueCard,
  listMessages,
  payWithCard,
  recordCardTransaction,
  resetDemo,
  ticketData,
  type DocumentInput,
} from "../lib/flow.ts";
import { fakeStripe, settleCard } from "./helpers/fake-stripe.ts";

const [anna, marco, giulia, paolo] = DEMO_USERS.map((u) => u.id);

const TAXI_QUOTE =
  "Il budget taxi per ogni trasferta è di 30 euro per i junior, 60 euro per i senior, 100 euro per i lead e 150 euro per i director.";
const taxi = (overrides: object = {}) => ({
  category: "taxi",
  amountCents: 4200,
  urgency: "immediate",
  reason: "Taxi dalla stazione",
  limitCents: 3000,
  clauseQuote: TAXI_QUOTE,
  policyGap: false,
  ...overrides,
});
const answer = (proposal: object): Llm => async () => ({ reply: "Ok.", show: "none", proposal });

function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "agenthon-card-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(join(directory, "test.sqlite"));
  t.after(() => db.close());
  return db;
}
type Db = ReturnType<typeof setup>;

const count = (db: Db, sql: string) => db.prepare(sql).get()?.count;
const expectError = (status: number, fn: () => unknown) =>
  assert.throws(fn, (error) => error instanceof FlowError && error.status === status);
const rejectsWith = (status: number, promise: Promise<unknown>) =>
  assert.rejects(promise, (error) => error instanceof FlowError && error.status === status);

async function submit(db: Db, userId: string, proposal: object = taxi(), now?: Date) {
  await agentTurn(db, userId, "Mi serve un taxi", answer(proposal));
  const messages = listMessages(db, userId).filter((m) => m.card && JSON.parse(m.card).type === "proposal");
  return confirmProposal(db, userId, messages.at(-1)!.id, now).request;
}

const today = () => new Date().toISOString().slice(0, 10);
const doc = (kind: "receipt" | "invoice", amountCents: number, extra: Partial<DocumentInput> = {}): DocumentInput => ({
  kind,
  amountCents,
  source: "upload",
  docDate: today(),
  ...extra,
});
const checksOfRequest = (db: Db, requestId: string) =>
  JSON.parse(String(db.prepare("SELECT raw_json FROM receipts WHERE request_id = ?").get(requestId)?.raw_json)).checks as { id: string; ok: boolean }[];
const failedChecks = (db: Db, requestId: string) => checksOfRequest(db, requestId).filter((c) => !c.ok).map((c) => c.id);

const cardOf = (db: Db, requestId: string) => db.prepare("SELECT * FROM cards WHERE request_id = ?").get(requestId);
const requestOf = (db: Db, requestId: string) => db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId)!;
const lastMessage = (db: Db, userId: string) => listMessages(db, userId).at(-1)!;

test("no Stripe call before the request is authorized", async (t) => {
  const db = setup(t);
  const stripe = fakeStripe();
  const sent = await submit(db, anna);
  assert.equal(sent.status, "pending_manager");
  assert.equal(sent.funding, null);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM cards"), 0);
  await rejectsWith(409, issueCard(db, stripe, sent.id));
  assert.equal(stripe.calls.length, 0);
});

test("auto-approval creates a pending card, issuing it uses the exact limit", async (t) => {
  const db = setup(t);
  const stripe = fakeStripe();
  const sent = await submit(db, marco, taxi({ limitCents: 6000 }));
  assert.equal(sent.status, "approved");
  assert.equal(sent.funding, "card");
  assert.equal((cardOf(db, sent.id) as any).status, "pending");
  assert.equal((cardOf(db, sent.id) as any).limit_cents, 4200);
  assert.equal(stripe.calls.length, 0, "la carta viene creata dopo il commit");

  const { card, duplicate } = await issueCard(db, stripe, sent.id);
  assert.equal(duplicate, false);
  assert.equal(card.status, "active");
  const create = stripe.calls.find((c) => c.method === "createCard")!.input as any;
  assert.equal(create.limitCents, 4200);
  assert.deepEqual(create.allowedCategories, ["taxicabs_limousines"]);
  assert.equal(create.requestId, sent.id);
  assert.ok(db.prepare("SELECT stripe_cardholder_id FROM roles_and_users WHERE id = ?").get(marco)?.stripe_cardholder_id);

  const message = lastMessage(db, marco);
  assert.deepEqual(JSON.parse(message.card!), { type: "card", requestId: sent.id });
  assert.match(message.content, /Conserva lo scontrino/);
  assert.doesNotMatch(message.content, /fattura/);
});

test("manager approval of the 42 EUR taxi issues a 42 EUR card", async (t) => {
  const db = setup(t);
  const stripe = fakeStripe();
  const sent = await submit(db, anna);
  decide(db, giulia, sent.id, "approved");
  assert.equal(stripe.calls.length, 0);
  await issueCard(db, stripe, sent.id);
  assert.equal(stripe.cards.size, 1);
  assert.equal([...stripe.cards.values()][0].limitCents, 4200);
  const view = cardView(db, sent.id);
  assert.equal(view.card?.status, "active");
  assert.deepEqual(view.required, ["receipt"]);
  assert.equal(view.billing, null);
});

test("issuing twice creates one card", async (t) => {
  const db = setup(t);
  const stripe = fakeStripe();
  const sent = await submit(db, anna);
  decide(db, giulia, sent.id, "approved");
  const [a, b] = await Promise.all([issueCard(db, stripe, sent.id), issueCard(db, stripe, sent.id)]);
  const again = await issueCard(db, stripe, sent.id);
  assert.equal(again.duplicate, true);
  assert.equal(a.card.stripe_card_id, b.card.stripe_card_id);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM cards"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM events WHERE type = 'card_issued'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM chat_messages WHERE card LIKE '%\"card\"%'"), 1);
});

test("a rejected waiver never reaches Stripe and reimburses up to the residual", async (t) => {
  const db = setup(t);
  const stripe = fakeStripe();
  const sent = await submit(db, anna);
  const rejected = decide(db, giulia, sent.id, "rejected").request;
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.authorized_cents, 3000);
  assert.equal(rejected.funding, "personal");
  assert.match(lastMessage(db, anna).content, /30,00/);
  assert.equal(cardOf(db, sent.id), undefined);
  await rejectsWith(409, issueCard(db, stripe, sent.id));
  await rejectsWith(409, payWithCard(db, stripe, anna, sent.id));
  assert.equal(stripe.calls.length, 0);

  // il residuo impegnato blocca un secondo rimborso sulla stessa categoria
  assert.equal(JSON.parse((await agentTurnBudget(db)).card!).budgetCents, 0);

  const done = attachDocument(db, anna, sent.id, doc("receipt", 4200));
  assert.equal(done.status, "finance_approved", "il rimborso limitato al residuo è una regola: approvato in automatico");
  const receipt = db.prepare("SELECT outcome, reimbursed_cents, amount_cents FROM receipts WHERE request_id = ?").get(sent.id)!;
  assert.deepEqual({ ...receipt }, { outcome: "capped", reimbursed_cents: 3000, amount_cents: 4200 });
  assert.match(lastMessage(db, anna).content, /resta a tuo carico/);

  financeApprove(db, paolo, sent.id);
  const [header, line] = exportCsv(db, paolo, sent.id).csv.trim().split("\n");
  const cols = header.split(",");
  const values = line.split(",");
  assert.deepEqual(cols.slice(-3), ["funding", "reimbursed_cents", "card_transaction_id"]);
  assert.deepEqual(values.slice(-3), ["personal", "3000", ""]);
});

async function agentTurnBudget(db: Db) {
  await agentTurn(db, anna, "Altro taxi", answer(taxi({ amountCents: 1000 })));
  return listMessages(db, anna).filter((m) => m.card && JSON.parse(m.card).type === "proposal").at(-1)!;
}

test("a rejected waiver with no residual means no reimbursement", async (t) => {
  const db = setup(t);
  const sent = await submit(db, anna);
  db.prepare("UPDATE requests SET budget_cents = 0, extra_cents = 4200 WHERE id = ?").run(sent.id);
  const rejected = decide(db, giulia, sent.id, "rejected").request;
  assert.equal(rejected.authorized_cents, null);
  assert.equal(rejected.funding, null);
  expectError(409, () => attachDocument(db, anna, sent.id, doc("receipt", 4200)));
  assert.match(lastMessage(db, anna).content, /nessun rimborso/i);
});

test("a payment above the card limit is declined", async (t) => {
  const db = setup(t);
  const stripe = fakeStripe();
  const sent = await submit(db, anna);
  decide(db, giulia, sent.id, "approved");
  await issueCard(db, stripe, sent.id);

  const declined = await payWithCard(db, stripe, anna, sent.id, 4201);
  assert.equal(declined.approved, false);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM card_transactions"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM events WHERE type = 'card_payment_declined'"), 1);
  assert.equal((cardOf(db, sent.id) as any).status, "active");
  assert.match(lastMessage(db, anna).content, /rifiutato/);

  const paid = await payWithCard(db, stripe, anna, sent.id);
  assert.equal(paid.approved, true);
  assert.equal(db.prepare("SELECT amount_cents FROM card_transactions").get()?.amount_cents, 4200);
  assert.equal((cardOf(db, sent.id) as any).status, "inactive");
  assert.ok(stripe.calls.some((c) => c.method === "deactivateCard"));
  assert.match(lastMessage(db, anna).content, /Pagato 42,00.*TAXI TORINO SOC\. COOP\./);
  await rejectsWith(409, payWithCard(db, stripe, anna, sent.id));
});

test("only the owner pays and only the owner attaches documents", async (t) => {
  const db = setup(t);
  const stripe = fakeStripe();
  const sent = await submit(db, anna);
  decide(db, giulia, sent.id, "approved");
  await issueCard(db, stripe, sent.id);
  await rejectsWith(403, payWithCard(db, stripe, marco, sent.id));
  await rejectsWith(403, payWithCard(db, stripe, giulia, sent.id));
  await rejectsWith(409, payWithCard(db, null, anna, sent.id));
  expectError(409, () => attachDocument(db, anna, sent.id, doc("receipt", 4200)));
  await payWithCard(db, stripe, anna, sent.id);
  expectError(403, () => attachDocument(db, marco, sent.id, doc("receipt", 4200)));
  expectError(403, () => attachDocument(db, giulia, sent.id, doc("receipt", 4200)));
  expectError(400, () => attachDocument(db, anna, sent.id, doc("receipt", 42.5)));
  expectError(400, () => attachDocument(db, anna, sent.id, { ...doc("receipt", 4200), kind: "x" as never }));
});

test("the same transaction recorded twice stays one row", async (t) => {
  const db = setup(t);
  const stripe = fakeStripe();
  const sent = await submit(db, anna);
  decide(db, giulia, sent.id, "approved");
  await settleCard(db, stripe, anna, sent.id);
  const transaction = stripe.transactions[0];

  const webhook = recordCardTransaction(db, transaction);
  assert.equal(webhook.duplicate, true);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM card_transactions"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM events WHERE type = 'card_payment_captured'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM chat_messages WHERE content LIKE 'Pagato%'"), 1);

  const unknown = recordCardTransaction(db, { ...transaction, id: "ipi_other", cardId: "ic_unknown" });
  assert.equal(unknown.recorded, false);
});

test("a taxi needs only the receipt", async (t) => {
  const db = setup(t);
  const sent = await submit(db, anna);
  decide(db, giulia, sent.id, "approved");
  await settleCard(db, fakeStripe(), anna, sent.id);
  const done = attachDocument(db, anna, sent.id, doc("receipt", 4200));
  assert.equal(done.status, "finance_approved");
  assert.equal(db.prepare("SELECT outcome FROM receipts").get()?.outcome, "match");
  assert.equal(db.prepare("SELECT decided_by, channel FROM approvals WHERE kind = 'finance'").get()?.channel, "agent");
  assert.match(lastMessage(db, paolo).content, /approvata in automatico/);
  expectError(409, () => attachDocument(db, anna, sent.id, doc("receipt", 4200)));
});

test("a hotel also needs an invoice made out to the company", async (t) => {
  const db = setup(t);
  const stripe = fakeStripe();

  const waiting = await submit(db, anna);
  db.prepare("UPDATE requests SET category = 'hotel' WHERE id = ?").run(waiting.id);
  decide(db, giulia, waiting.id, "approved");
  await issueCard(db, stripe, waiting.id);
  assert.match(lastMessage(db, anna).content, new RegExp(COMPANY_BILLING.name.replace(".", "\\.")));
  assert.match(lastMessage(db, anna).content, /disabilitata/);
  await payWithCard(db, stripe, anna, waiting.id);
  assert.match(lastMessage(db, anna).content, /fattura intestata a/);
  assert.equal(cardView(db, waiting.id).billing?.vatNumber, COMPANY_BILLING.vatNumber);

  assert.equal(attachDocument(db, anna, waiting.id, doc("receipt", 4200)).status, "approved", "senza fattura resta in attesa");
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM receipts"), 0);
  assert.deepEqual(cardView(db, waiting.id).missing, ["invoice"]);
  const complete = attachDocument(db, anna, waiting.id, doc("invoice", 4200, { invoicedToCompany: true, vatNumber: "IT01234567897" }));
  assert.equal(complete.status, "finance_approved");

  // fattura intestata a un privato
  const wrong = await submit(db, marco, taxi({ limitCents: 6000 }));
  db.prepare("UPDATE requests SET category = 'hotel' WHERE id = ?").run(wrong.id);
  await settleCard(db, stripe, marco, wrong.id);
  attachDocument(db, marco, wrong.id, doc("receipt", 4200));
  const review = attachDocument(db, marco, wrong.id, doc("invoice", 4200, { invoicedToCompany: false }));
  assert.equal(review.status, "in_review");
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM events WHERE type = 'invoice_not_company'"), 1);
  assert.deepEqual(failedChecks(db, wrong.id), ["invoice_company"]);
});

test("an invoice with a different amount or no readable buyer goes to review", async (t) => {
  const db = setup(t);
  const stripe = fakeStripe();
  const first = await submit(db, anna);
  db.prepare("UPDATE requests SET category = 'hotel' WHERE id = ?").run(first.id);
  decide(db, giulia, first.id, "approved");
  await settleCard(db, stripe, anna, first.id);
  attachDocument(db, anna, first.id, doc("receipt", 4200));
  assert.equal(attachDocument(db, anna, first.id, doc("invoice", 3900, { invoicedToCompany: true })).status, "in_review");
  assert.deepEqual(failedChecks(db, first.id), ["invoice_amount"]);

  const second = await submit(db, marco, taxi({ limitCents: 6000 }));
  db.prepare("UPDATE requests SET category = 'hotel' WHERE id = ?").run(second.id);
  await settleCard(db, stripe, marco, second.id);
  attachDocument(db, marco, second.id, doc("receipt", 4200));
  assert.equal(attachDocument(db, marco, second.id, doc("invoice", 4200, { invoicedToCompany: null })).status, "in_review");
  assert.deepEqual(failedChecks(db, second.id), ["invoice_company"]);
});

test("card digits, transaction reference and date printed on the receipt must match", async (t) => {
  const db = setup(t);
  const stripe = fakeStripe();
  const paidWith = async (userId: string, proposal = taxi()) => {
    const sent = await submit(db, userId, proposal);
    if (sent.status === "pending_manager") decide(db, giulia, sent.id, "approved");
    await settleCard(db, stripe, userId, sent.id);
    const card = cardView(db, sent.id);
    return { id: sent.id, last4: card.card!.last4!, transaction: card.transaction! };
  };

  // tutto stampato e coerente: approvata in automatico
  const ok = await paidWith(anna);
  const okDoc = doc("receipt", 4200, { cardLast4: ok.last4, transactionRef: ok.transaction.id });
  assert.equal(attachDocument(db, anna, ok.id, okDoc).status, "finance_approved");
  assert.deepEqual(checksOfRequest(db, ok.id).map((c) => c.id), ["within_authorized", "transaction_amount", "transaction_date", "card_last4", "transaction_ref"]);

  const wrongCard = await paidWith(marco, taxi({ limitCents: 6000 }));
  assert.equal(attachDocument(db, marco, wrongCard.id, doc("receipt", 4200, { cardLast4: "0000" === wrongCard.last4 ? "1111" : "0000" })).status, "in_review");
  assert.deepEqual(failedChecks(db, wrongCard.id), ["card_last4"]);

  const wrongRef = await paidWith(marco, taxi({ amountCents: 1000, limitCents: 6000 }));
  assert.equal(attachDocument(db, marco, wrongRef.id, doc("receipt", 1000, { transactionRef: "ipi_altra_transazione" })).status, "in_review");
  assert.deepEqual(failedChecks(db, wrongRef.id), ["transaction_ref"]);

  const oldDate = await paidWith(marco, taxi({ amountCents: 900, limitCents: 6000 }));
  assert.equal(attachDocument(db, marco, oldDate.id, doc("receipt", 900, { docDate: "2020-01-01" })).status, "in_review");
  assert.deepEqual(failedChecks(db, oldDate.id), ["transaction_date"]);

  const noDate = await paidWith(marco, taxi({ amountCents: 800, limitCents: 6000 }));
  assert.equal(attachDocument(db, marco, noDate.id, doc("receipt", 800, { docDate: null })).status, "in_review");
  assert.deepEqual(failedChecks(db, noDate.id), ["transaction_date"]);
});

test("a receipt that differs from the transaction goes to review", async (t) => {
  const db = setup(t);
  const sent = await submit(db, anna);
  decide(db, giulia, sent.id, "approved");
  await settleCard(db, fakeStripe(), anna, sent.id);
  assert.equal(attachDocument(db, anna, sent.id, doc("receipt", 4000)).status, "in_review");
  assert.equal(db.prepare("SELECT outcome FROM receipts").get()?.outcome, "mismatch");
  assert.deepEqual(failedChecks(db, sent.id), ["transaction_amount"]);
  assert.match(lastMessage(db, paolo).content, /da rivedere/);
  expectError(409, () => exportCsv(db, paolo, sent.id));
  // Finance controlla e approva a mano
  expectError(403, () => financeApprove(db, giulia, sent.id));
  assert.equal(financeApprove(db, paolo, sent.id).request.status, "finance_approved");
  assert.equal(db.prepare("SELECT channel, decided_by FROM approvals WHERE kind = 'finance'").get()?.decided_by, paolo);
});

test("a receipt above the authorized amount cannot be approved by Finance", async (t) => {
  const db = setup(t);
  const sent = await submit(db, anna);
  decide(db, giulia, sent.id, "approved");
  await settleCard(db, fakeStripe(), anna, sent.id);
  assert.equal(attachDocument(db, anna, sent.id, doc("receipt", 4800)).status, "in_review");
  assert.equal(db.prepare("SELECT outcome FROM receipts").get()?.outcome, "over_authorized");
  expectError(409, () => financeApprove(db, paolo, sent.id));
});

test("Finance approving twice leaves one decision", async (t) => {
  const db = setup(t);
  const sent = await submit(db, anna);
  decide(db, giulia, sent.id, "approved");
  await settleCard(db, fakeStripe(), anna, sent.id);
  attachDocument(db, anna, sent.id, doc("receipt", 4000));
  assert.equal(financeApprove(db, paolo, sent.id).duplicate, false);
  assert.equal(financeApprove(db, paolo, sent.id).duplicate, true);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM approvals WHERE kind = 'finance'"), 1);
  const { csv } = exportCsv(db, paolo, sent.id);
  assert.match(csv.trim().split("\n")[1], /,Paolo Neri,.*,card,0,ipi_fake_\d+$/);
});

test("missing documents after seven days block new cards", async (t) => {
  const db = setup(t);
  const stripe = fakeStripe();
  const first = await submit(db, anna);
  decide(db, giulia, first.id, "approved");
  await settleCard(db, stripe, anna, first.id);

  const day = 24 * 60 * 60 * 1000;
  const within = new Date(Date.now() + (DOCUMENT_DEADLINE_DAYS - 1) * day);
  const late = new Date(Date.now() + (DOCUMENT_DEADLINE_DAYS + 1) * day);

  const second = await submit(db, anna, taxi({ amountCents: 1000 }));
  const ok = decide(db, giulia, second.id, "approved", "web", within).request;
  assert.equal(ok.funding, "card");

  const third = await submit(db, anna, taxi({ amountCents: 1500 }));
  const blocked = decide(db, giulia, third.id, "approved", "web", late).request;
  assert.equal(blocked.funding, "personal");
  assert.equal(cardOf(db, third.id), undefined);
  assert.match(lastMessage(db, anna).content, /Non genero la carta/);
  assert.match(lastMessage(db, anna).content, /15,00/);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM events WHERE type = 'card_blocked_documents'"), 1);
  await rejectsWith(409, issueCard(db, stripe, third.id));

  // il percorso con carta personale accetta lo scontrino fino all'autorizzato
  assert.equal(attachDocument(db, anna, third.id, doc("receipt", 1500)).status, "finance_approved");

  // con i documenti completi il blocco cade
  attachDocument(db, anna, first.id, doc("receipt", 4200));
  const fourth = await submit(db, anna, taxi({ amountCents: 900 }));
  assert.equal(decide(db, giulia, fourth.id, "approved", "web", late).request.funding, "card");
});

test("without Stripe the request falls back to a personal card", async (t) => {
  const db = setup(t);
  const sent = await submit(db, anna);
  decide(db, giulia, sent.id, "approved");
  const { card } = await issueCard(db, null, sent.id);
  assert.equal(card.status, "failed");
  assert.equal(requestOf(db, sent.id).funding, "personal");
  assert.match(lastMessage(db, anna).content, /Carta non generata.*rimborso fino a 42,00/);

  assert.equal(attachDocument(db, anna, sent.id, doc("receipt", 4200)).status, "finance_approved");
  assert.equal(db.prepare("SELECT reimbursed_cents FROM receipts").get()?.reimbursed_cents, 4200);
});

test("a Stripe error also falls back to a personal card", async (t) => {
  const db = setup(t);
  const stripe = fakeStripe();
  stripe.failCreate = true;
  const sent = await submit(db, anna);
  decide(db, giulia, sent.id, "approved");
  const { card } = await issueCard(db, stripe, sent.id);
  assert.equal(card.status, "failed");
  assert.match(card.error!, /non raggiungibile/);
  assert.equal(requestOf(db, sent.id).funding, "personal");
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM events WHERE type = 'card_failed'"), 1);
});

test("the historic path without funding keeps working", async (t) => {
  const db = setup(t);
  const sent = await submit(db, anna);
  decide(db, giulia, sent.id, "approved");
  db.exec("DELETE FROM cards");
  db.prepare("UPDATE requests SET funding = NULL WHERE id = ?").run(sent.id);
  assert.equal(attachReceipt(db, anna, sent.id, "over").status, "in_review");
  assert.equal(db.prepare("SELECT outcome FROM receipts").get()?.outcome, "over_authorized");
});

test("the Finance ticket data needs the Finance role and a verified receipt", async (t) => {
  const db = setup(t);
  const sent = await submit(db, anna);
  decide(db, giulia, sent.id, "approved");
  await settleCard(db, fakeStripe(), anna, sent.id);
  expectError(403, () => ticketData(db, anna, sent.id));
  expectError(409, () => ticketData(db, paolo, sent.id));
  attachReceipt(db, anna, sent.id, "exact");
  const data = ticketData(db, paolo, sent.id);
  assert.equal(data.request.authorizedCents, 4200);
  assert.equal(data.request.funding, "card");
  assert.equal(data.employee.email, "anna.rossi@gattidemo.example");
  assert.equal(data.card?.limitCents, 4200);
  assert.equal(data.transaction?.merchantName, "TAXI TORINO SOC. COOP.");
  assert.equal(data.documents.length, 1);
  assert.equal(data.verification?.outcome, "match");
  assert.deepEqual(data.decisions.map((d) => [d.by, d.channel]), [["Giulia Verdi", "web"], ["Agente di verifica", "agent"]]);
});

test("reset clears cards, transactions and documents but keeps cardholders", async (t) => {
  const db = setup(t);
  const sent = await submit(db, anna);
  decide(db, giulia, sent.id, "approved");
  await settleCard(db, fakeStripe(), anna, sent.id);
  attachReceipt(db, anna, sent.id, "exact");
  resetDemo(db);
  for (const table of ["cards", "card_transactions", "documents", "receipts", "requests"]) {
    assert.equal(count(db, `SELECT COUNT(*) AS count FROM ${table}`), 0, table);
  }
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM expense_categories"), 8);
  assert.ok(db.prepare("SELECT stripe_cardholder_id FROM roles_and_users WHERE id = ?").get(anna)?.stripe_cardholder_id);
});

test("assertCanAttach checks owner, state and kind before any extraction", async (t) => {
  const db = setup(t);
  const stripe = fakeStripe();
  const sent = await submit(db, anna);
  decide(db, giulia, sent.id, "approved");
  await issueCard(db, stripe, sent.id);
  expectError(409, () => assertCanAttach(db, anna, sent.id, "receipt"));
  await payWithCard(db, stripe, anna, sent.id);
  expectError(403, () => assertCanAttach(db, marco, sent.id, "receipt"));
  expectError(403, () => assertCanAttach(db, giulia, sent.id, "receipt"));
  expectError(400, () => assertCanAttach(db, anna, sent.id, "x"));
  expectError(409, () => assertCanAttach(db, anna, sent.id, "invoice"));
  assert.equal(assertCanAttach(db, anna, sent.id, "receipt").id, sent.id);
  attachDocument(db, anna, sent.id, doc("receipt", 4200));
  expectError(409, () => assertCanAttach(db, anna, sent.id, "receipt"));
});
