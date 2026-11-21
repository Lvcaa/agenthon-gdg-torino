import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { agentTurn, type Llm } from "../lib/agent.ts";
import { DEMO_USERS, openDatabase } from "../lib/db.ts";
import { FlowError, attachReceipt, confirmProposal, decide, financeApprove, listMessages } from "../lib/flow.ts";
import {
  documentDownload,
  employeeRequests,
  financePeople,
  financeTickets,
  managerDecisions,
  managerQueue,
  parseUrgency,
  safeDocumentPath,
} from "../lib/views.ts";
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
  const directory = mkdtempSync(join(tmpdir(), "agenthon-views-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(join(directory, "test.sqlite"));
  t.after(() => db.close());
  return db;
}
type Db = ReturnType<typeof setup>;

async function submit(db: Db, userId: string, proposal: object) {
  await agentTurn(db, userId, "Mi serve un taxi", answer(proposal));
  const message = listMessages(db, userId).filter((m) => m.card && JSON.parse(m.card).type === "proposal").at(-1)!;
  return confirmProposal(db, userId, message.id).request;
}

function expectError(status: number, fn: () => unknown) {
  assert.throws(fn, (error) => error instanceof FlowError && error.status === status);
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

test("le mie richieste: in corso con i documenti mancanti, completate dopo Finance", async (t) => {
  const db = setup(t);
  const r = await submit(db, anna, taxi());

  let open = employeeRequests(db, anna, "open");
  assert.deepEqual(ids(open), [r.id], "in attesa del manager è in corso");
  assert.deepEqual(open[0].missing, [], "prima dell'approvazione non si chiedono documenti");
  assert.deepEqual(employeeRequests(db, anna, "done"), []);

  decide(db, giulia, r.id, "approved");
  open = employeeRequests(db, anna, "open");
  assert.deepEqual(open[0].missing, ["receipt"], "taxi: solo lo scontrino, niente fattura");
  assert.equal(open[0].canUpload, false, "con la carta si carica dopo il pagamento");

  await settleCard(db, fakeStripe(), anna, r.id);
  assert.equal(employeeRequests(db, anna, "open")[0].canUpload, true);

  attachReceipt(db, anna, r.id, "exact");
  assert.deepEqual(employeeRequests(db, anna, "open"), []);
  assert.deepEqual(ids(employeeRequests(db, anna, "done")), [r.id]);

  assert.deepEqual(employeeRequests(db, marco, "open"), [], "ognuno vede solo le sue");
  expectError(403, () => employeeRequests(db, giulia, "open"));
  expectError(401, () => employeeRequests(db, undefined, "open"));
});

test("deroga rifiutata: in corso con residuo, completata senza", async (t) => {
  const db = setup(t);
  // Marco (senior, 60 €) chiede 70 €: rifiuto con residuo, paga con la sua carta fino a 60 €.
  const withResidual = await submit(db, marco, taxi({ amountCents: 7000, limitCents: 6000 }));
  decide(db, giulia, withResidual.id, "rejected");
  const open = employeeRequests(db, marco, "open");
  assert.deepEqual(ids(open), [withResidual.id]);
  assert.deepEqual(open[0].missing, ["receipt"]);
  assert.equal(open[0].canUpload, true, "carta personale: si carica subito");

  // Anna esaurisce il residuo con 42 € approvati, poi chiede 10 € e viene rifiutata: nessun rimborso.
  const first = await submit(db, anna, taxi());
  decide(db, giulia, first.id, "approved");
  const noResidual = await submit(db, anna, taxi({ amountCents: 1000 }));
  assert.equal(noResidual.budget_cents, 0);
  decide(db, giulia, noResidual.id, "rejected");
  assert.deepEqual(ids(employeeRequests(db, anna, "done")), [noResidual.id]);
  assert.deepEqual(ids(employeeRequests(db, anna, "open")), [first.id]);
});

test("manager: coda filtrata per urgenza e storico delle decisioni", async (t) => {
  const db = setup(t);
  const now = await submit(db, anna, taxi());
  const later = await submit(db, marco, taxi({ amountCents: 7000, limitCents: 6000, urgency: "week" }));

  assert.deepEqual(ids(managerQueue(db, giulia)), [now.id, later.id], "ordinate per priorità");
  assert.deepEqual(ids(managerQueue(db, giulia, "week")), [later.id]);
  assert.deepEqual(managerQueue(db, giulia, "day"), []);
  assert.equal(parseUrgency("week"), "week");
  assert.equal(parseUrgency("subito"), null, "un filtro sconosciuto vale come «tutte»");

  decide(db, giulia, now.id, "approved");
  decide(db, giulia, later.id, "rejected");
  assert.deepEqual(managerQueue(db, giulia), []);
  const approved = managerDecisions(db, giulia, "approved");
  assert.deepEqual(ids(approved), [now.id]);
  assert.equal(approved[0].decided_by, "Giulia Verdi");
  assert.equal(approved[0].channel, "web");
  assert.deepEqual(ids(managerDecisions(db, giulia, "rejected")), [later.id]);

  // Entro il residuo: approvata in automatico, non è una decisione del manager.
  await submit(db, marco, taxi({ amountCents: 2000, limitCents: 6000 }));
  assert.equal(managerDecisions(db, giulia, "approved").length, 1);

  expectError(403, () => managerQueue(db, anna));
  expectError(403, () => managerDecisions(db, paolo, "approved"));
});

test("finance: ricerca per nome e ticket con i download", async (t) => {
  const db = setup(t);
  const r = await submit(db, anna, taxi());
  decide(db, giulia, r.id, "approved");

  assert.deepEqual(financePeople(db, paolo, "ann").map((p) => p.name), ["Anna Rossi"]);
  assert.deepEqual(financePeople(db, paolo, "  ROSSI ").map((p) => p.name), ["Anna Rossi"], "maiuscole e spazi non contano");
  assert.deepEqual(financePeople(db, paolo).map((p) => p.name), ["Anna Rossi", "Marco Bianchi"], "solo i dipendenti");
  assert.deepEqual(financePeople(db, paolo, "%"), [], "i caratteri jolly sono letterali");
  const annaRow = financePeople(db, paolo, "anna")[0];
  assert.equal(annaRow.requests, 1);
  assert.equal(annaRow.authorized_cents, 4200);

  let [ticket] = financeTickets(db, paolo, anna);
  assert.deepEqual(ticket.downloads, [], "nessun documento prima del pagamento");
  expectError(404, () => documentDownload(db, paolo, r.id, "transaction"));
  expectError(404, () => documentDownload(db, paolo, r.id, "receipt"));

  await settleCard(db, fakeStripe(), anna, r.id);
  attachReceipt(db, anna, r.id, "exact");
  [ticket] = financeTickets(db, paolo, anna);
  assert.deepEqual(ticket.downloads, [
    { kind: "receipt", original: false },
    { kind: "transaction", original: false },
  ]);
  assert.equal(ticket.outcome, "match");
  assert.equal(ticket.spent_cents, 4200);
  assert.deepEqual(ticket.decisions.map((d) => [d.kind, d.decision, d.by]), [
    ["manager", "approved", "Giulia Verdi"],
    ["finance", "approved", "Agente di verifica"],
  ]);
  assert.equal(ticket.canApprove, false, "già approvata in automatico");
  assert.ok(ticket.checks.every((c) => c.ok));

  const receipt = documentDownload(db, paolo, r.id, "receipt");
  assert.equal(receipt.type, "summary", "scontrino sintetico: PDF con i dati estratti");
  const transaction = documentDownload(db, paolo, r.id, "transaction");
  assert.equal(transaction.type, "transaction");
  if (transaction.type === "transaction") assert.equal(transaction.transaction.amountCents, 4200);
  expectError(404, () => documentDownload(db, paolo, r.id, "invoice"));
  expectError(400, () => documentDownload(db, paolo, r.id, "../../etc/passwd"));
  expectError(404, () => documentDownload(db, paolo, "nessuna", "receipt"));

  expectError(403, () => documentDownload(db, anna, r.id, "receipt"));
  expectError(403, () => documentDownload(db, giulia, r.id, "transaction"));
  expectError(403, () => financePeople(db, anna));
  expectError(403, () => financeTickets(db, giulia, anna));
  expectError(404, () => financeTickets(db, paolo, "sconosciuto"));
});

test("safeDocumentPath accetta solo file dentro la cartella dei documenti", () => {
  const root = resolve("/srv/app/data/documents");
  assert.equal(safeDocumentPath("/srv/app/data/documents/abc/receipt.pdf", root), join(root, "abc", "receipt.pdf"));
  assert.equal(safeDocumentPath("/srv/app/data/documents/../agenthon.sqlite", root), null);
  assert.equal(safeDocumentPath("/etc/passwd", root), null);
  assert.equal(safeDocumentPath("/srv/app/data/documents", root), null);
  assert.equal(safeDocumentPath(null, root), null);
});
