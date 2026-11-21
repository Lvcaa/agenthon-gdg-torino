import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { agentTurn, type Llm } from "../lib/agent.ts";
import { DEMO_USERS, openDatabase } from "../lib/db.ts";
import {
  FlowError,
  attachReceipt,
  computePriority,
  confirmProposal,
  createLinkCode,
  decide,
  exportCsv,
  financeApprove,
  listMessages,
  listRequests,
  redeemLinkCode,
  resetDemo,
} from "../lib/flow.ts";
import { chunkPolicy, excerpts, ingestPolicy, readPolicy, retrieve } from "../lib/policy.ts";
import { uploadPolicyPdf } from "../lib/policy-upload.ts";
import { makePdf } from "./helpers/pdf.ts";
import { verifyProposal } from "../lib/proposal.ts";

const [anna, marco, giulia, paolo] = DEMO_USERS.map((u) => u.id);

// Citazioni copiate dalla policy: il server le cerca nel testo.
const TAXI_QUOTE =
  "Il budget taxi per ogni trasferta è di 30 euro per i junior, 60 euro per i senior, 100 euro per i lead e 150 euro per i director.";
const MEALS_QUOTE = "Per i pasti durante la trasferta il budget è di 40 euro per i junior e 60 euro per i senior.";

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

const answer = (proposal: object | null, extra: object = {}): Llm => async () => ({ reply: "Ok.", show: "none", proposal, ...extra });

function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "agenthon-flow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(join(directory, "test.sqlite"));
  t.after(() => db.close());
  return db;
}
type Db = ReturnType<typeof setup>;

function expectError(status: number, fn: () => unknown) {
  assert.throws(fn, (error) => error instanceof FlowError && error.status === status);
}

function lastProposalMessage(db: Db, userId: string) {
  const messages = listMessages(db, userId).filter((m) => m.card && JSON.parse(m.card).type === "proposal");
  return messages[messages.length - 1];
}

// Il dipendente chiede, l'agente propone, il dipendente conferma.
async function requestAndConfirm(db: Db, userId: string, proposal: object = taxi()) {
  await agentTurn(db, userId, "Mi serve un taxi", answer(proposal));
  const message = lastProposalMessage(db, userId);
  assert.ok(message, "nessuna proposta in chat");
  return confirmProposal(db, userId, message.id).request;
}

const count = (db: Db, sql: string) => db.prepare(sql).get()?.count;

test("the 42 EUR taxi goes from chat to CSV", async (t) => {
  const db = setup(t);
  await agentTurn(db, anna, "Sono davanti alla stazione, il taxi costa 42 euro", answer(taxi()));

  const message = lastProposalMessage(db, anna);
  const card = JSON.parse(message.card!);
  assert.equal(card.budgetCents, 3000);
  assert.equal(card.extraCents, 1200);
  assert.equal(card.priority, 4);
  assert.equal(card.proposal.clauseRef, "2. Trasporti locali (taxi) (p. 1)");
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM requests"), 0, "la proposta non crea ancora una pratica");

  const sent = confirmProposal(db, anna, message.id).request;
  assert.equal(sent.status, "pending_manager");
  assert.equal(sent.clause_quote, TAXI_QUOTE);
  assert.equal(sent.policy_version, readPolicy(db).version);

  assert.equal(decide(db, giulia, sent.id, "approved").request.authorized_cents, 4200);
  assert.equal(attachReceipt(db, anna, sent.id, "exact").status, "pending_finance");
  assert.equal(financeApprove(db, paolo, sent.id).request.status, "finance_approved");

  const { csv } = exportCsv(db, paolo, sent.id);
  const [header, line] = csv.trim().split("\n");
  assert.match(header, /^request_id,trip_id,employee,category,amount_cents,amount_eur/);
  assert.match(line, /,T-042,Anna Rossi,taxi,4200,42\.00,R-[0-9A-F]{8},Giulia Verdi,Paolo Neri,[0-9a-f]{8},2\. Trasporti locali \(taxi\) \(p\. 1\)$/);
  assert.equal(listRequests(db)[0].status, "exported");

  const types = db.prepare("SELECT type FROM events ORDER BY id").all().map((e) => e.type);
  assert.deepEqual(types, ["request_submitted", "manager_approved", "receipt_verified", "finance_approved", "csv_exported"]);
});

test("the server rejects limits that the policy does not support", (t) => {
  const policy = readPolicy(setup(t));
  const bad = (overrides: object) => verifyProposal(taxi(overrides), policy);

  assert.equal(bad({}).ok, true);
  assert.equal(bad({ clauseQuote: "Il taxi costa sempre 99 euro per tutti i dipendenti." }).ok, false, "citazione inventata");
  assert.equal(bad({ limitCents: 9900 }).ok, false, "numero non presente nella citazione");
  assert.equal(bad({ clauseQuote: null }).ok, false);
  assert.equal(bad({ limitCents: null }).ok, false);
  assert.equal(bad({ amountCents: 12.5 }).ok, false);
  assert.equal(bad({ amountCents: -1 }).ok, false);
  assert.equal(bad({ category: "yacht" }).ok, false);
  assert.equal(bad({ urgency: "now" }).ok, false);
  assert.equal(bad({ reason: " " }).ok, false);

  const gap = bad({ policyGap: true, limitCents: null, clauseQuote: null });
  assert.ok(gap.ok);
  assert.equal(gap.proposal.limitCents, null);

  const quoted = verifyProposal(taxi({ clauseQuote: "BUDGET   TAXI per ogni trasferta è di 30 euro per i junior" }), policy);
  assert.ok(quoted.ok, "spazi e maiuscole non contano");
});

test("a wrong proposal gets one retry with the server feedback", async (t) => {
  const db = setup(t);
  const prompts: string[] = [];
  const llm: Llm = async (prompt) => {
    prompts.push(prompt);
    return { reply: "Ok.", show: "none", proposal: prompts.length === 1 ? taxi({ limitCents: 9900 }) : taxi() };
  };
  await agentTurn(db, anna, "Taxi da 42 euro", llm);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /VERIFICA DEL SERVER FALLITA/);
  assert.equal(JSON.parse(lastProposalMessage(db, anna).card!).proposal.limitCents, 3000);
});

test("a proposal that stays unverifiable goes to the manager as a policy gap", async (t) => {
  const db = setup(t);
  await agentTurn(db, anna, "Taxi da 42 euro", answer(taxi({ clauseQuote: "frase inventata che non è nella policy" })));
  const card = JSON.parse(lastProposalMessage(db, anna).card!);
  assert.equal(card.proposal.policyGap, true);
  assert.equal(card.proposal.limitCents, null);
  assert.equal(card.extraCents, 4200);
  assert.match(listMessages(db, anna).at(-1)!.content, /non ho potuto verificare/i);
});

test("a case the policy does not cover reaches the manager flagged", async (t) => {
  const db = setup(t);
  const sent = await requestAndConfirm(db, anna, {
    category: "other",
    amountCents: 2500,
    urgency: "day",
    reason: "Parcheggio",
    limitCents: null,
    clauseQuote: null,
    policyGap: true,
  });
  assert.equal(sent.status, "pending_manager");
  assert.equal(sent.policy_gap, 1);
  assert.equal(sent.budget_cents, 0);
  assert.equal(sent.extra_cents, 2500);
  assert.match(sent.priority_rule, /policy non chiara/);
});

test("without a proposal the agent only answers, and nothing is created", async (t) => {
  const db = setup(t);
  await agentTurn(db, anna, "Quanto costa il taxi?", async () => ({ reply: "Qual è l'importo?", show: "none", proposal: null }));
  const messages = listMessages(db, anna);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(messages[1].card, null);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM requests"), 0);
});

test("only an employee gets a proposal and only the owner can confirm it", async (t) => {
  const db = setup(t);
  await agentTurn(db, giulia, "Voglio un taxi", answer(taxi()));
  assert.equal(lastProposalMessage(db, giulia), undefined);

  await agentTurn(db, anna, "Taxi da 42", answer(taxi()));
  const message = lastProposalMessage(db, anna);
  expectError(404, () => confirmProposal(db, marco, message.id));
  expectError(403, () => confirmProposal(db, giulia, message.id));
  expectError(401, () => confirmProposal(db, "unknown", message.id));
  expectError(404, () => confirmProposal(db, anna, 99999));
  expectError(404, () => confirmProposal(db, anna, listMessages(db, anna)[0].id));
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM requests"), 0);
});

test("confirming twice creates one request", async (t) => {
  const db = setup(t);
  await agentTurn(db, anna, "Taxi da 42", answer(taxi()));
  const message = lastProposalMessage(db, anna);
  const first = confirmProposal(db, anna, message.id);
  const second = confirmProposal(db, anna, message.id);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.request.id, first.request.id);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM requests"), 1);
});

test("a tampered proposal is not accepted at confirmation", async (t) => {
  const db = setup(t);
  await agentTurn(db, anna, "Taxi da 42", answer(taxi()));
  const message = lastProposalMessage(db, anna);
  const card = JSON.parse(message.card!);
  card.proposal.limitCents = 99900;
  db.prepare("UPDATE chat_messages SET card = ? WHERE id = ?").run(JSON.stringify(card), message.id);
  expectError(409, () => confirmProposal(db, anna, message.id));
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM requests"), 0);
});

test("an employee cannot approve, not even their own request", async (t) => {
  const db = setup(t);
  const sent = await requestAndConfirm(db, anna);
  expectError(403, () => decide(db, anna, sent.id, "approved"));
  expectError(403, () => decide(db, marco, sent.id, "approved"));
  expectError(403, () => decide(db, paolo, sent.id, "approved"));
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM approvals"), 0);
});

test("export is blocked until Finance approves", async (t) => {
  const db = setup(t);
  const sent = await requestAndConfirm(db, anna);
  expectError(409, () => exportCsv(db, paolo, sent.id));
  decide(db, giulia, sent.id, "approved");
  expectError(409, () => exportCsv(db, paolo, sent.id));
  attachReceipt(db, anna, sent.id, "exact");
  expectError(409, () => exportCsv(db, paolo, sent.id));
  expectError(403, () => financeApprove(db, giulia, sent.id));
  financeApprove(db, paolo, sent.id);
  expectError(403, () => exportCsv(db, giulia, sent.id));
  expectError(403, () => exportCsv(db, anna, sent.id));
  exportCsv(db, paolo, sent.id);
});

test("a rejected request stays out of the Finance queue and is logged", async (t) => {
  const db = setup(t);
  const sent = await requestAndConfirm(db, anna);
  decide(db, giulia, sent.id, "rejected");
  assert.equal(listRequests(db, { statuses: ["pending_finance", "finance_approved"] }).length, 0);
  expectError(409, () => attachReceipt(db, anna, sent.id, "exact"));
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM events WHERE type = 'manager_rejected'"), 1);
});

test("the receipt follows the authorized amount of the request", async (t) => {
  const db = setup(t);
  const sent = await requestAndConfirm(db, anna, taxi({ amountCents: 3100 }));
  decide(db, giulia, sent.id, "approved");
  expectError(400, () => attachReceipt(db, anna, sent.id, "42"));
  const done = attachReceipt(db, anna, sent.id, "exact");
  assert.equal(done.status, "pending_finance");
  assert.equal(db.prepare("SELECT amount_cents FROM receipts WHERE request_id = ?").get(sent.id)?.amount_cents, 3100);
  assert.equal(listRequests(db, { statuses: ["pending_finance"] }).length, 1);
});

test("a 48 EUR receipt stays in review", async (t) => {
  const db = setup(t);
  const sent = await requestAndConfirm(db, anna);
  decide(db, giulia, sent.id, "approved");
  assert.equal(attachReceipt(db, anna, sent.id, "over").status, "in_review");
  assert.equal(listRequests(db, { statuses: ["pending_finance"] }).length, 0);
  expectError(409, () => financeApprove(db, paolo, sent.id));
});

test("approving twice leaves one decision", async (t) => {
  const db = setup(t);
  const sent = await requestAndConfirm(db, anna);
  assert.equal(decide(db, giulia, sent.id, "approved").duplicate, false);
  assert.equal(decide(db, giulia, sent.id, "approved").duplicate, true);
  expectError(409, () => decide(db, giulia, sent.id, "rejected"));
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM approvals WHERE kind = 'manager'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM events WHERE type = 'manager_approved'"), 1);

  attachReceipt(db, anna, sent.id, "exact");
  assert.equal(financeApprove(db, paolo, sent.id).duplicate, false);
  assert.equal(financeApprove(db, paolo, sent.id).duplicate, true);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM approvals WHERE kind = 'finance'"), 1);
});

test("a request within the profile limit needs no waiver", async (t) => {
  const db = setup(t);
  const sent = await requestAndConfirm(db, marco, taxi({ limitCents: 6000 }));
  assert.equal(sent.extra_cents, 0);
  assert.equal(sent.status, "approved");
  assert.equal(sent.authorized_cents, 4200);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM approvals"), 0);
});

test("the authorized amount is deducted from the next proposal", async (t) => {
  const db = setup(t);
  const sent = await requestAndConfirm(db, anna);
  decide(db, giulia, sent.id, "approved");
  await agentTurn(db, anna, "Altro taxi da 10 euro", answer(taxi({ amountCents: 1000 })));
  assert.equal(JSON.parse(lastProposalMessage(db, anna).card!).budgetCents, 0);
});

test("people are notified in their own chat", async (t) => {
  const db = setup(t);
  const sent = await requestAndConfirm(db, anna);

  const managerMessage = listMessages(db, giulia).at(-1)!;
  assert.equal(managerMessage.role, "assistant");
  assert.match(managerMessage.content, /Anna Rossi/);
  assert.match(managerMessage.content, /Urgente/);
  assert.deepEqual(JSON.parse(managerMessage.card!).ids, [sent.id]);

  decide(db, giulia, sent.id, "approved");
  assert.match(listMessages(db, anna).at(-1)!.content, /Giulia Verdi ha approvato/);

  attachReceipt(db, anna, sent.id, "exact");
  assert.match(listMessages(db, paolo).at(-1)!.content, /verificata/);
});

test("the agent can show the queue, the log and a Telegram code", async (t) => {
  const db = setup(t);
  const sent = await requestAndConfirm(db, anna);

  await agentTurn(db, giulia, "Cosa ho in coda?", answer(null, { show: "queue" }));
  assert.deepEqual(JSON.parse(listMessages(db, giulia).at(-1)!.card!), { type: "requests", ids: [sent.id] });

  await agentTurn(db, anna, "Mostrami il registro", answer(null, { show: "registry" }));
  assert.deepEqual(JSON.parse(listMessages(db, anna).at(-1)!.card!), { type: "events" });

  await agentTurn(db, anna, "Collega Telegram", answer(null, { show: "telegram_code" }));
  const card = JSON.parse(listMessages(db, anna).at(-1)!.card!);
  assert.equal(card.type, "telegram_code");
  assert.match(card.code, /^[A-Z2-9]{6}$/);
  assert.equal(redeemLinkCode(db, card.code, "100").name, "Anna Rossi");
});

test("a model failure is reported in the chat without breaking", async (t) => {
  const db = setup(t);
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });
  await agentTurn(db, anna, "Ciao", async () => {
    throw new Error("503");
  });
  assert.match(listMessages(db, anna).at(-1)!.content, /Non riesco a contattare il modello/);
});

test("messages are validated", async (t) => {
  const db = setup(t);
  await assert.rejects(agentTurn(db, anna, "   ", answer(null)), (e) => e instanceof FlowError && e.status === 400);
  await assert.rejects(agentTurn(db, anna, "x".repeat(1001), answer(null)), (e) => e instanceof FlowError && e.status === 400);
  await assert.rejects(agentTurn(db, "unknown", "ciao", answer(null)), (e) => e instanceof FlowError && e.status === 401);
});

test("priority comes from urgency and rises with a large extra", () => {
  assert.equal(computePriority("later", 0).label, "Bassa");
  assert.equal(computePriority("week", 0).label, "Normale");
  assert.equal(computePriority("day", 500).label, "Alta");
  assert.equal(computePriority("day", 1200).label, "Urgente");
  assert.equal(computePriority("immediate", 1200).level, 4);
  assert.match(computePriority("day", 0, true).rule, /policy non chiara/);
});

test("reset clears the scenario, chat included", async (t) => {
  const db = setup(t);
  const sent = await requestAndConfirm(db, anna);
  decide(db, giulia, sent.id, "approved");
  resetDemo(db);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM requests"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM chat_messages"), 0);
  await agentTurn(db, anna, "Taxi da 42", answer(taxi()));
  assert.equal(JSON.parse(lastProposalMessage(db, anna).card!).budgetCents, 3000);
});

test("the Telegram link code is single use and expires", (t) => {
  const db = setup(t);
  const { code } = createLinkCode(db, anna);
  expectError(404, () => redeemLinkCode(db, "ZZZZZZ", "100"));
  const actor = redeemLinkCode(db, code.toLowerCase(), "100");
  assert.equal(actor.name, "Anna Rossi");
  assert.equal(actor.permission, "employee");
  expectError(409, () => redeemLinkCode(db, code, "100"));

  const second = createLinkCode(db, marco).code;
  expectError(409, () => redeemLinkCode(db, second, "100"));

  const third = createLinkCode(db, anna).code;
  expectError(409, () => redeemLinkCode(db, third, "200"));

  const expired = createLinkCode(db, giulia).code;
  db.prepare("UPDATE telegram_link_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE code = ?").run(expired);
  expectError(410, () => redeemLinkCode(db, expired, "300"));
});

test("the meals clause covers junior and senior only", (t) => {
  const policy = readPolicy(setup(t));
  const ok = verifyProposal(taxi({ category: "meals", amountCents: 3000, limitCents: 4000, clauseQuote: MEALS_QUOTE }), policy);
  assert.ok(ok.ok);
  assert.equal(ok.proposal.clauseRef, "4. Pasti (p. 1)");
});

// ---------- Policy a pezzi, ricerca e caricamento del PDF ----------

const pdfPolicy = [
  ["POLITICA TRASFERTE", "Questo documento descrive le regole di spesa in trasferta.", "1. Taxi", "Il budget taxi e di 25 euro per i junior e 45 euro per i senior.", "Oltre il limite serve una deroga del manager."],
  ["2. Treno", "Il treno e ammesso in seconda classe fino a 90 euro per i junior e 160 euro per i senior."],
];

test("chunking follows headings, keeps the page and splits long sections", () => {
  const chunks = chunkPolicy([
    "# Titolo\n\n## 1. Taxi\nIl taxi costa 30 euro.\n\n## 2. Treno\nSeconda classe.",
    "3. HOTEL\n" + Array.from({ length: 40 }, (_, i) => `Riga ${i} con un testo abbastanza lungo da riempire il pezzo corrente.`).join("\n"),
  ]);
  assert.deepEqual(chunks.slice(0, 2).map((c) => [c.heading, c.page]), [["1. Taxi", 1], ["2. Treno", 1]]);
  const hotel = chunks.filter((c) => c.heading.startsWith("3. HOTEL"));
  assert.ok(hotel.length >= 2, "una sezione lunga si divide");
  assert.match(hotel[0].heading, /\(1\/\d+\)$/);
  assert.ok(hotel.every((c) => c.page === 2 && c.text.length <= 1250));
});

test("a wrapped line that starts with a number is text, not a heading", () => {
  const chunks = chunkPolicy([
    "2. Taxi\nIl budget taxi per ogni trasferta è di 30 euro per i junior, 60 euro per i senior, 100 euro per i\n100 euro per i lead e 150 euro per i director\n3. Treno\nSeconda classe.",
  ]);
  assert.deepEqual(chunks.map((c) => c.heading), ["2. Taxi", "3. Treno"]);
  assert.match(chunks[0].text, /100 euro per i lead/);
});

test("retrieval finds the right sections and sends far fewer characters than the whole policy", (t) => {
  const db = setup(t);
  const filler = (n: number) =>
    Array.from({ length: 12 }, (_, i) => `Per la categoria ${n} valgono regole interne numero ${i} sulla gestione amministrativa dei documenti.`).join("\n");
  const sections = [
    ...Array.from({ length: 35 }, (_, i) => `${i + 1}. Argomento ${i + 1}\n${filler(i)}`),
    "36. Taxi\nIl budget taxi è di 30 euro per i junior e 60 euro per i senior.",
    "37. Hotel\nIl pernottamento ha un budget di 100 euro per i junior.",
  ];
  const policy = ingestPolicy(db, { filename: "grande.pdf", source: "pdf", pages: [sections.join("\n")] });

  const taxi = retrieve(policy, "Il taxi costa 42 euro, posso?", 4);
  assert.ok(taxi.some((c) => c.heading === "36. Taxi"));
  const hotel = retrieve(policy, "Dormire in albergo per una notte", 4);
  assert.ok(hotel.some((c) => c.heading === "37. Hotel"), "i sinonimi portano alla sezione hotel");

  assert.ok(excerpts(taxi).length < policy.text.length * 0.25, `${excerpts(taxi).length} vs ${policy.text.length}`);
});

test("only Finance uploads the policy PDF, and the server checks the file", async (t) => {
  const db = setup(t);
  const dir = mkdtempSync(join(tmpdir(), "agenthon-pdf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pdf = makePdf(pdfPolicy);
  const reject = (status: number, actor: string, file: { name: string; bytes: Uint8Array }) =>
    assert.rejects(uploadPolicyPdf(db, actor, file, dir), (e) => e instanceof FlowError && e.status === status);

  await reject(403, anna, { name: "p.pdf", bytes: pdf });
  await reject(403, giulia, { name: "p.pdf", bytes: pdf });
  await reject(401, "unknown", { name: "p.pdf", bytes: pdf });
  await reject(415, paolo, { name: "p.pdf", bytes: new TextEncoder().encode("non sono un pdf") });
  await reject(413, paolo, { name: "p.pdf", bytes: new Uint8Array(0) });
  await reject(422, paolo, { name: "p.pdf", bytes: makePdf([["Pagina quasi vuota"]]) });
  assert.equal(readPolicy(db).filename, "policy.md", "i rifiuti non cambiano la policy attiva");

  const policy = await uploadPolicyPdf(db, paolo, { name: "../../etc/Policy 2026?.pdf", bytes: pdf }, dir);
  assert.equal(policy.filename, "Policy 2026_.pdf");
  assert.equal(policy.pages, 2);
  assert.deepEqual(policy.chunks.map((c) => [c.heading, c.page]), [["POLITICA TRASFERTE", 1], ["1. Taxi", 1], ["2. Treno", 2]]);
  assert.equal(readPolicy(db).version, policy.version);
  assert.ok(existsSync(join(dir, `${policy.version}.pdf`)));
  assert.deepEqual(new Uint8Array(readFileSync(join(dir, `${policy.version}.pdf`))), pdf, "il PDF salvato è identico all'originale");
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM events WHERE type = 'policy_uploaded'"), 1);
  assert.equal(JSON.parse(listMessages(db, paolo).at(-1)!.card!).version, policy.version);

  const again = await uploadPolicyPdf(db, paolo, { name: "stessa.pdf", bytes: pdf }, dir);
  assert.equal(again.version, policy.version, "lo stesso contenuto ha la stessa versione");
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM policy_documents"), 2);
});

test("a request made on the uploaded PDF keeps that policy version and quotes it", async (t) => {
  const db = setup(t);
  const dir = mkdtempSync(join(tmpdir(), "agenthon-pdf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const policy = await uploadPolicyPdf(db, paolo, { name: "p.pdf", bytes: makePdf(pdfPolicy) }, dir);

  const quote = "Il budget taxi e di 25 euro per i junior e 45 euro per i senior.";
  const sent = await requestAndConfirm(db, anna, taxi({ limitCents: 2500, clauseQuote: quote }));
  assert.equal(sent.policy_version, policy.version);
  assert.equal(sent.clause_id, "1. Taxi (p. 1)");
  assert.equal(sent.budget_cents, 2500);
  assert.equal(sent.extra_cents, 1700);

  await agentTurn(db, anna, "Taxi da 42", answer(taxi({ limitCents: 3000 })));
  assert.equal(lastProposalMessage(db, anna).card!.includes('"policyGap":true'), true, "la vecchia citazione non è più nella policy attiva");
});

test("a pending proposal is refused if the policy changes before confirmation", async (t) => {
  const db = setup(t);
  const dir = mkdtempSync(join(tmpdir(), "agenthon-pdf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await agentTurn(db, anna, "Taxi da 42", answer(taxi()));
  const message = lastProposalMessage(db, anna);
  await uploadPolicyPdf(db, paolo, { name: "p.pdf", bytes: makePdf(pdfPolicy) }, dir);
  expectError(409, () => confirmProposal(db, anna, message.id));
});

test("when the model reports a gap, the search is widened once", async (t) => {
  const db = setup(t);
  const prompts: string[] = [];
  const llm: Llm = async (prompt, system) => {
    prompts.push(system);
    return {
      reply: "Ok.",
      show: "none",
      proposal: prompts.length === 1 ? taxi({ policyGap: true, limitCents: null, clauseQuote: null }) : taxi(),
    };
  };
  await agentTurn(db, anna, "Taxi da 42 euro", llm);
  assert.equal(prompts.length, 2);
  const card = JSON.parse(lastProposalMessage(db, anna).card!);
  assert.equal(card.proposal.policyGap, false);
  assert.equal(card.proposal.limitCents, 3000);
});

test("the prompt carries the index and excerpts, not the whole document", async (t) => {
  const db = setup(t);
  let system = "";
  await agentTurn(db, anna, "Taxi da 42 euro", async (_p, s) => {
    system = s;
    return { reply: "Ok.", show: "none", proposal: null };
  });
  assert.match(system, /INDICE/);
  assert.match(system, /ESTRATTI PERTINENTI/);
  assert.match(system, /\[S\d+ · p\. 1 · 2\. Trasporti locali \(taxi\)\]/);
});
