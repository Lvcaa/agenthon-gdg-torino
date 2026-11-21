import { randomInt, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { COMPANY_BILLING, EXPENSE_CATEGORIES, type CategoryRule } from "./categories.ts";
import { DEMO_TRIP_ID } from "./db.ts";
import { normalizeRef } from "./document-extract.ts";
import { formatEuro } from "./format.ts";
import { readPolicy, type Category } from "./policy.ts";
import { verifyProposal, type Urgency, type VerifiedProposal } from "./proposal.ts";
import type { CapturedTransaction, StripeIssuing } from "./stripe.ts";
import type { TicketData } from "./ticket-pdf.ts";

// Logica del flusso: tutti i controlli di ruolo, stato e importo stanno qui, mai nel modello né nel client.
// Il modello propone, il server verifica e registra. Le azioni (invio, approvazione, export) partono solo
// da un'azione esplicita dell'utente e passano da queste funzioni.
// Identità: in modalità demo l'attore è il suo UUID e il permesso viene letto dal database.

export class FlowError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "FlowError";
    this.status = status;
  }
}

export type Permission = "employee" | "manager" | "finance";
export type Status =
  | "draft"
  | "pending_manager"
  | "approved"
  | "rejected"
  | "in_review"
  | "pending_finance"
  | "finance_approved"
  | "exported";

export type Funding = "card" | "personal";
export type DocumentKind = "receipt" | "invoice";
export type ReceiptOutcome = "match" | "over_authorized" | "capped" | "mismatch";

// Giorni dopo il pagamento con carta entro cui servono i documenti. Oltre, le nuove approvazioni non generano carta.
export const DOCUMENT_DEADLINE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Actor {
  id: string;
  name: string;
  role: string;
  permission: Permission;
}

export interface RequestRow {
  id: string;
  trip_id: string;
  user_id: string;
  category: Category;
  amount_cents: number;
  budget_cents: number;
  extra_cents: number;
  authorized_cents: number | null;
  status: Status;
  priority: number;
  priority_rule: string;
  urgency: Urgency;
  clause_quote: string | null;
  policy_gap: number;
  policy_version: string;
  clause_id: string;
  reason: string;
  funding: Funding | null;
  created_at: string;
  updated_at: string;
}

export interface CardRow {
  id: string;
  request_id: string;
  stripe_card_id: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  limit_cents: number;
  allowed_categories: string;
  status: "pending" | "active" | "inactive" | "failed";
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CardTransactionRow {
  id: string;
  request_id: string;
  stripe_card_id: string;
  authorization_id: string | null;
  amount_cents: number;
  merchant_name: string;
  merchant_category: string;
  merchant_city: string | null;
  captured_at: string;
  raw_json: string;
}

export interface DocumentRow {
  id: string;
  request_id: string;
  kind: DocumentKind;
  amount_cents: number;
  merchant: string | null;
  doc_date: string | null;
  vat_number: string | null;
  invoiced_to_company: number | null;
  payment_method: "card" | "cash" | "unknown";
  card_last4: string | null;
  transaction_ref: string | null;
  source: "upload" | "synthetic";
  filename: string | null;
  mime: string | null;
  path: string | null;
  extracted_json: string | null;
  created_at: string;
}

export interface ReceiptRow {
  id: string;
  request_id: string;
  amount_cents: number;
  outcome: ReceiptOutcome;
  raw_json: string;
  verified_at: string;
  reimbursed_cents: number | null;
}

export interface RequestView extends RequestRow {
  employee_name: string;
  employee_role: string;
  priority_label: string;
}

// Elemento mostrato sotto un messaggio dell'assistente.
export type Card =
  | { type: "proposal"; proposal: VerifiedProposal; budgetCents: number; extraCents: number; priority: number; priorityLabel: string }
  | { type: "requests"; ids: string[] }
  | { type: "events" }
  | { type: "telegram_code"; code: string; expiresAt: string }
  | { type: "policy"; version: string }
  | { type: "card"; requestId: string };

const COMMITTED_STATUSES = "'approved', 'in_review', 'pending_finance', 'finance_approved', 'exported'";
// Un rifiuto con residuo lascia un autorizzato (percorso con carta personale) che conta come impegnato.
const COMMITTED_CLAUSE = `(status IN (${COMMITTED_STATUSES}) OR (status = 'rejected' AND authorized_cents IS NOT NULL))`;
const URGENCY_LEVEL: Record<Urgency, number> = { later: 1, week: 2, day: 3, immediate: 4 };
const PRIORITY_LABELS = ["", "Bassa", "Normale", "Alta", "Urgente"];
const PRIORITY_RULES: Record<Urgency, string> = {
  later: "spesa prevista tra più di sette giorni",
  week: "spesa prevista entro sette giorni",
  day: "spesa prevista entro 24 ore",
  immediate: "spesa immediata, il dipendente attende la risposta",
};
const EXTRA_BUMP_THRESHOLD_CENTS = 1000;
export const RECEIPT_OVER_CENTS = 600; // la variante «oltre l'autorizzato» supera di 6 €
// Nome con cui compaiono le decisioni automatiche (approvals.channel = 'agent', decided_by vuoto).
export const AGENT_NAME = "Agente di verifica";
const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LINK_CODE_TTL_MS = 10 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function logEvent(db: DatabaseSync, requestId: string | null, actorId: string | null, type: string, payload: object = {}) {
  db.prepare("INSERT INTO events (request_id, actor_id, type, payload) VALUES (?, ?, ?, ?)").run(
    requestId,
    actorId,
    type,
    JSON.stringify(payload),
  );
}

// Messaggio in chat. Le notifiche agli altri utenti sono messaggi dell'assistente con un elemento sotto.
export function addMessage(
  db: DatabaseSync,
  userId: string,
  role: "user" | "assistant",
  content: string,
  card: Card | null = null,
): number {
  const result = db
    .prepare("INSERT INTO chat_messages (user_id, role, content, card) VALUES (?, ?, ?, ?)")
    .run(userId, role, content, card ? JSON.stringify(card) : null);
  return Number(result.lastInsertRowid);
}

function say(db: DatabaseSync, userId: string, content: string, requestId?: string) {
  addMessage(db, userId, "assistant", content, requestId ? { type: "requests", ids: [requestId] } : null);
}

function usersWith(db: DatabaseSync, permission: Permission): string[] {
  return db
    .prepare("SELECT id FROM roles_and_users WHERE permission = ?")
    .all(permission)
    .map((row) => row.id as string);
}

export function getActor(db: DatabaseSync, actorId: unknown, permission?: Permission): Actor {
  if (typeof actorId !== "string" || !actorId) throw new FlowError(401, "Utente non indicato");
  const actor = db
    .prepare("SELECT id, name, role, permission FROM roles_and_users WHERE id = ?")
    .get(actorId) as unknown as Actor | undefined;
  if (!actor) throw new FlowError(401, "Utente sconosciuto");
  if (permission && actor.permission !== permission) {
    throw new FlowError(403, `Azione riservata al ruolo ${permission}`);
  }
  return actor;
}

function getRequest(db: DatabaseSync, requestId: unknown): RequestRow {
  const row =
    typeof requestId === "string"
      ? (db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as unknown as RequestRow | undefined)
      : undefined;
  if (!row) throw new FlowError(404, "Pratica non trovata");
  return row;
}

function setStatus(db: DatabaseSync, requestId: string, status: Status, authorizedCents?: number) {
  if (authorizedCents === undefined) {
    db.prepare("UPDATE requests SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), requestId);
  } else {
    db.prepare("UPDATE requests SET status = ?, authorized_cents = ?, updated_at = ? WHERE id = ?").run(
      status,
      authorizedCents,
      nowIso(),
      requestId,
    );
  }
}

// Quanto è già autorizzato per questo utente e categoria nella trasferta. Il limite lo legge l'agente dalla policy.
export function committedFor(db: DatabaseSync, userId: string, category: Category, tripId = DEMO_TRIP_ID): number {
  return db
    .prepare(
      `SELECT COALESCE(SUM(authorized_cents), 0) AS cents FROM requests
       WHERE user_id = ? AND trip_id = ? AND category = ? AND ${COMMITTED_CLAUSE}`,
    )
    .get(userId, tripId, category)?.cents as number;
}

export function computePriority(urgency: Urgency, extraCents: number, policyGap = false) {
  const base = URGENCY_LEVEL[urgency];
  if (!base) throw new FlowError(400, "Urgenza non valida");
  const bumped = extraCents > EXTRA_BUMP_THRESHOLD_CENTS;
  const level = Math.min(4, base + (bumped ? 1 : 0));
  const rule = [PRIORITY_RULES[urgency], bumped ? "extra sopra soglia, +1 livello" : "", policyGap ? "policy non chiara" : ""]
    .filter(Boolean)
    .join("; ");
  return { level, label: PRIORITY_LABELS[level], rule };
}

// Numeri che il server mostra e salva: residuo, extra e priorità.
export function assessProposal(db: DatabaseSync, userId: string, proposal: VerifiedProposal) {
  const budget =
    proposal.limitCents === null ? 0 : Math.max(0, proposal.limitCents - committedFor(db, userId, proposal.category));
  const extra = Math.max(0, proposal.amountCents - budget);
  return { budget, extra, priority: computePriority(proposal.urgency, extra, proposal.policyGap) };
}

export function categoryRule(code: string): CategoryRule {
  const rule = EXPENSE_CATEGORIES.find((c) => c.code === code);
  if (!rule) throw new FlowError(500, `Categoria sconosciuta: ${code}`);
  return rule;
}

export function userEmail(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");
  return `${slug}@gattidemo.example`;
}

function requiredKinds(rule: CategoryRule): DocumentKind[] {
  return rule.requiresInvoice ? ["receipt", "invoice"] : ["receipt"];
}

function documentsOf(db: DatabaseSync, requestId: string): DocumentRow[] {
  return db.prepare("SELECT * FROM documents WHERE request_id = ? ORDER BY created_at, kind").all(requestId) as unknown as DocumentRow[];
}

function missingKinds(db: DatabaseSync, row: RequestRow): DocumentKind[] {
  const have = new Set(documentsOf(db, row.id).map((d) => d.kind));
  return requiredKinds(categoryRule(row.category)).filter((k) => !have.has(k));
}

function cardOf(db: DatabaseSync, requestId: string): CardRow | undefined {
  return db.prepare("SELECT * FROM cards WHERE request_id = ?").get(requestId) as unknown as CardRow | undefined;
}

function transactionOf(db: DatabaseSync, requestId: string): CardTransactionRow | undefined {
  return db
    .prepare("SELECT * FROM card_transactions WHERE request_id = ? ORDER BY captured_at, id LIMIT 1")
    .get(requestId) as unknown as CardTransactionRow | undefined;
}

// Pratica pagata con carta da più di DOCUMENT_DEADLINE_DAYS giorni senza documenti completi (regola 6).
function overdueCardRequest(db: DatabaseSync, userId: string, now: Date): RequestRow | null {
  const rows = db
    .prepare(
      `SELECT r.*, MIN(ct.captured_at) AS paid_at FROM requests r
       JOIN card_transactions ct ON ct.request_id = r.id
       WHERE r.user_id = ? AND r.funding = 'card' GROUP BY r.id`,
    )
    .all(userId) as unknown as (RequestRow & { paid_at: string })[];
  for (const row of rows) {
    if (now.getTime() - Date.parse(row.paid_at) > DOCUMENT_DEADLINE_DAYS * DAY_MS && missingKinds(db, row).length > 0) return row;
  }
  return null;
}

const personalHint = (cents: number) => `Paga con la tua carta e carica lo scontrino: rimborso fino a ${formatEuro(cents)}.`;

// Pratica autorizzata: prepara la carta (pending, la crea Stripe dopo il commit) o il percorso con carta personale.
function startFunding(db: DatabaseSync, row: RequestRow, authorizedCents: number, now: Date): "card" | "personal-blocked" {
  const overdue = overdueCardRequest(db, row.user_id, now);
  if (overdue) {
    db.prepare("UPDATE requests SET funding = 'personal' WHERE id = ?").run(row.id);
    logEvent(db, row.id, null, "card_blocked_documents", { overdueRequestId: overdue.id, deadlineDays: DOCUMENT_DEADLINE_DAYS });
    return "personal-blocked";
  }
  const rule = categoryRule(row.category);
  db.prepare("INSERT INTO cards (id, request_id, limit_cents, allowed_categories, status) VALUES (?, ?, ?, ?, 'pending')").run(
    randomUUID(),
    row.id,
    authorizedCents,
    JSON.stringify(rule.stripeCategories),
  );
  db.prepare("UPDATE requests SET funding = 'card' WHERE id = ?").run(row.id);
  return "card";
}

function blockedText(authorizedCents: number): string {
  return `Non genero la carta: hai documenti in sospeso da più di ${DOCUMENT_DEADLINE_DAYS} giorni su una pratica pagata con carta. ${personalHint(authorizedCents)}`;
}

// 1. Il dipendente conferma la proposta dell'agente. Il server la rilegge dalla chat, la riverifica sulla
// policy corrente e ricalcola tutto: il client manda solo l'id del messaggio.
export function confirmProposal(
  db: DatabaseSync,
  actorId: unknown,
  messageId: unknown,
  now: Date = new Date(),
): { request: RequestRow; duplicate: boolean } {
  const actor = getActor(db, actorId, "employee");
  return tx(db, () => {
    const message =
      typeof messageId === "number"
        ? (db.prepare("SELECT user_id, role, card, request_id FROM chat_messages WHERE id = ?").get(messageId) as unknown as
            | { user_id: string; role: string; card: string | null; request_id: string | null }
            | undefined)
        : undefined;
    if (!message || message.user_id !== actor.id || message.role !== "assistant") throw new FlowError(404, "Proposta non trovata");
    const card = message.card ? (JSON.parse(message.card) as Card) : null;
    if (card?.type !== "proposal") throw new FlowError(404, "Il messaggio non contiene una proposta");
    if (message.request_id) return { request: getRequest(db, message.request_id), duplicate: true };

    const policy = readPolicy(db);
    const check = verifyProposal(card.proposal, policy);
    if (!check.ok || card.proposal.policyVersion !== policy.version) {
      throw new FlowError(409, "La policy è cambiata dopo la proposta: chiedi di nuovo all'assistente");
    }
    const proposal = check.proposal;
    const { budget, extra, priority } = assessProposal(db, actor.id, proposal);

    const id = randomUUID();
    db.prepare(
      `INSERT INTO requests (id, trip_id, user_id, category, amount_cents, budget_cents, extra_cents,
         priority, priority_rule, urgency, clause_quote, policy_gap, policy_version, clause_id, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, DEMO_TRIP_ID, actor.id, proposal.category, proposal.amountCents, budget, extra,
      priority.level, priority.rule, proposal.urgency, proposal.clauseQuote, proposal.policyGap ? 1 : 0,
      proposal.policyVersion, proposal.clauseRef, proposal.reason,
    );
    logEvent(db, id, actor.id, "request_submitted", {
      category: proposal.category,
      amountCents: proposal.amountCents,
      budgetCents: budget,
      extraCents: extra,
      priority: priority.level,
      clauseRef: proposal.clauseRef,
      policyGap: proposal.policyGap,
    });
    db.prepare("UPDATE chat_messages SET request_id = ? WHERE id = ?").run(id, messageId as number);

    if (extra === 0) {
      // Dentro il limite del profilo: nessuna deroga, la spesa è già autorizzata.
      setStatus(db, id, "approved", proposal.amountCents);
      logEvent(db, id, null, "auto_approved_within_budget", { authorizedCents: proposal.amountCents });
      const funding = startFunding(db, getRequest(db, id), proposal.amountCents, now);
      say(
        db,
        actor.id,
        `Spesa di ${formatEuro(proposal.amountCents)} autorizzata: rientra nel tuo limite. ${
          funding === "card" ? "Sto generando la carta virtuale." : blockedText(proposal.amountCents)
        }`,
        id,
      );
    } else {
      setStatus(db, id, "pending_manager");
      say(db, actor.id, `Richiesta inviata al manager. Chiede una deroga di ${formatEuro(extra)}.`, id);
      for (const managerId of usersWith(db, "manager")) {
        say(
          db,
          managerId,
          `Nuova richiesta di ${actor.name} · priorità ${priority.label}: ${formatEuro(proposal.amountCents)} (${proposal.category}), extra ${formatEuro(extra)}.${proposal.policyGap ? " La policy non copre chiaramente il caso." : ""}`,
          id,
        );
      }
    }
    return { request: getRequest(db, id), duplicate: false };
  });
}

// 2. Il manager decide. Una seconda decisione identica non crea una seconda riga.
export function decide(
  db: DatabaseSync,
  actorId: unknown,
  requestId: unknown,
  decision: unknown,
  channel: "web" | "telegram" = "web",
  now: Date = new Date(),
): { request: RequestRow; duplicate: boolean } {
  if (decision !== "approved" && decision !== "rejected") throw new FlowError(400, "Decisione non valida");
  const actor = getActor(db, actorId, "manager");
  return tx(db, () => {
    const row = getRequest(db, requestId);
    if (row.user_id === actor.id) throw new FlowError(403, "Non puoi decidere sulla tua richiesta");
    if (row.status !== "pending_manager") {
      const previous = db
        .prepare("SELECT decision FROM approvals WHERE request_id = ? AND kind = 'manager'")
        .get(row.id)?.decision;
      if (previous === decision) return { request: row, duplicate: true };
      throw new FlowError(409, "La richiesta non è in attesa del manager");
    }
    const authorized = decision === "approved" ? row.amount_cents : null;
    db.prepare(
      "INSERT INTO approvals (request_id, kind, decision, decided_by, channel, amount_cents) VALUES (?, 'manager', ?, ?, ?, ?)",
    ).run(row.id, decision, actor.id, channel, authorized);
    // Rifiuto con residuo: la spesa resta a carico del dipendente (carta personale) e si rimborsa fino al residuo.
    const personalCap = decision === "rejected" && row.budget_cents > 0 ? row.budget_cents : null;
    if (decision === "approved") setStatus(db, row.id, "approved", row.amount_cents);
    else if (personalCap !== null) {
      setStatus(db, row.id, "rejected", personalCap);
      db.prepare("UPDATE requests SET funding = 'personal' WHERE id = ?").run(row.id);
    } else setStatus(db, row.id, "rejected");
    logEvent(db, row.id, actor.id, decision === "approved" ? "manager_approved" : "manager_rejected", {
      channel,
      authorizedCents: authorized ?? personalCap,
      extraCents: row.extra_cents,
    });
    let text: string;
    if (decision === "approved") {
      const funding = startFunding(db, getRequest(db, row.id), row.amount_cents, now);
      text = `${actor.name} ha approvato fino a ${formatEuro(row.amount_cents)}. ${
        funding === "card" ? "Sto generando la carta virtuale." : blockedText(row.amount_cents)
      }`;
    } else if (personalCap !== null) {
      text = `${actor.name} ha rifiutato la deroga. Puoi spendere fino a ${formatEuro(personalCap)} (il tuo residuo) con la tua carta: carica lo scontrino e ti rimborsiamo a fine mese. L'eccedenza resta a tuo carico.`;
    } else {
      text = `${actor.name} ha rifiutato la deroga. Il tuo residuo è esaurito: nessun rimborso previsto.`;
    }
    say(db, row.user_id, text, row.id);
    say(db, actor.id, decision === "approved" ? "Approvata." : "Rifiutata.", row.id);
    return { request: getRequest(db, row.id), duplicate: false };
  });
}

// 3a. Carta virtuale. Le funzioni async chiamano Stripe fuori da ogni transazione SQLite:
// leggono e validano in tx, chiamano la rete, riscrivono in una nuova tx ricontrollando lo stato.
function failCard(db: DatabaseSync, row: RequestRow, card: CardRow, reason: string) {
  const error = reason.slice(0, 300);
  db.prepare("UPDATE cards SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, nowIso(), card.id);
  db.prepare("UPDATE requests SET funding = 'personal' WHERE id = ?").run(row.id);
  logEvent(db, row.id, null, "card_failed", { error });
  say(
    db,
    row.user_id,
    `Carta non generata: ${error}. Paga con la tua carta e carica lo scontrino, rimborso fino a ${formatEuro(card.limit_cents)}.`,
    row.id,
  );
}

export async function issueCard(
  db: DatabaseSync,
  stripe: StripeIssuing | null,
  requestId: unknown,
): Promise<{ card: CardRow; duplicate: boolean }> {
  const prep = tx(db, () => {
    const row = getRequest(db, requestId);
    const card = cardOf(db, row.id);
    if (!card) throw new FlowError(409, "Nessuna carta da generare per questa pratica");
    if (card.status !== "pending") return { done: { card, duplicate: true } };
    if (row.status !== "approved") throw new FlowError(409, "La pratica non è autorizzata");
    if (!stripe) {
      failCard(db, row, card, "Stripe non è configurato");
      return { done: { card: cardOf(db, row.id)!, duplicate: false } };
    }
    const user = db.prepare("SELECT id, name, stripe_cardholder_id FROM roles_and_users WHERE id = ?").get(row.user_id) as unknown as {
      id: string;
      name: string;
      stripe_cardholder_id: string | null;
    };
    return { row, card, user };
  });
  if ("done" in prep && prep.done) return prep.done;
  const { row, card, user } = prep as Exclude<typeof prep, { done: unknown }>;

  let cardholderId: string;
  let issued: Awaited<ReturnType<StripeIssuing["createCard"]>>;
  try {
    cardholderId = await stripe!.ensureCardholder({
      userId: user.id,
      name: user.name,
      email: userEmail(user.name),
      existingId: user.stripe_cardholder_id,
    });
    issued = await stripe!.createCard({
      requestId: row.id,
      cardholderId,
      limitCents: card.limit_cents,
      allowedCategories: JSON.parse(card.allowed_categories) as string[],
    });
  } catch (error) {
    return tx(db, () => {
      const current = cardOf(db, row.id)!;
      if (current.status !== "pending") return { card: current, duplicate: true };
      failCard(db, getRequest(db, row.id), current, error instanceof Error ? error.message : String(error));
      return { card: cardOf(db, row.id)!, duplicate: false };
    });
  }

  return tx(db, () => {
    const current = cardOf(db, row.id)!;
    if (current.status !== "pending") return { card: current, duplicate: true };
    const fresh = getRequest(db, row.id);
    db.prepare("UPDATE roles_and_users SET stripe_cardholder_id = ? WHERE id = ?").run(cardholderId, user.id);
    db.prepare(
      `UPDATE cards SET stripe_card_id = ?, last4 = ?, exp_month = ?, exp_year = ?, status = ?, error = NULL, updated_at = ? WHERE id = ?`,
    ).run(issued.id, issued.last4, issued.expMonth, issued.expYear, issued.status === "active" ? "active" : "inactive", nowIso(), current.id);
    logEvent(db, row.id, null, "card_issued", { last4: issued.last4, limitCents: current.limit_cents });
    const rule = categoryRule(fresh.category);
    const base = `Carta virtuale pronta: •••• ${issued.last4}, monouso, fino a ${formatEuro(current.limit_cents)}.`;
    const tail = rule.requiresInvoice
      ? ` Chiedi la fattura intestata a ${COMPANY_BILLING.name}: senza documento la carta potrebbe essere disabilitata in futuro.`
      : ` Conserva lo scontrino/la ricevuta.`;
    addMessage(db, fresh.user_id, "assistant", base + tail, { type: "card", requestId: fresh.id });
    return { card: cardOf(db, row.id)!, duplicate: false };
  });
}

const SYNTHETIC_MERCHANTS: Record<string, string> = {
  taxi: "TAXI TORINO SOC. COOP.",
  train: "TRENITALIA TORINO PN",
  meals: "RISTORANTE DEL CAMBIO",
  hotel: "GRAND HOTEL SITEA",
};
const DEFAULT_MERCHANT_CATEGORY = "miscellaneous_general_services";

// Solo sandbox: simula il pagamento del dipendente con la carta. Importo di default = autorizzato.
export async function payWithCard(
  db: DatabaseSync,
  stripe: StripeIssuing | null,
  actorId: unknown,
  requestId: unknown,
  amountCents?: number,
): Promise<{ approved: boolean; reason?: string; transactionId?: string; duplicate?: boolean }> {
  const actor = getActor(db, actorId, "employee");
  const prep = tx(db, () => {
    const row = getRequest(db, requestId);
    if (row.user_id !== actor.id) throw new FlowError(403, "Puoi pagare solo con le carte delle tue richieste");
    if (!stripe) throw new FlowError(409, "Il pagamento di prova richiede una chiave Stripe sandbox");
    const card = cardOf(db, row.id);
    if (!card || card.status !== "active" || !card.stripe_card_id) throw new FlowError(409, "Nessuna carta attiva per questa pratica");
    if (transactionOf(db, row.id)) throw new FlowError(409, "La carta è già stata usata");
    const amount = amountCents ?? card.limit_cents;
    if (!Number.isInteger(amount) || amount <= 0) throw new FlowError(400, "Importo non valido");
    return { row, card, amount };
  });
  const { row, card, amount } = prep;
  const rule = categoryRule(row.category);
  const result = await stripe!.simulatePayment({
    cardId: card.stripe_card_id!,
    amountCents: amount,
    merchantName: SYNTHETIC_MERCHANTS[row.category] ?? "FORNITORE DEMO",
    merchantCategory: rule.stripeCategories[0] ?? DEFAULT_MERCHANT_CATEGORY,
    merchantCity: "Torino",
    idempotencyKey: `pay-${row.id}-${amount}`,
  });
  if (!result.approved) {
    tx(db, () => {
      logEvent(db, row.id, actor.id, "card_payment_declined", {
        amountCents: amount,
        reason: result.reason,
        authorizationId: result.authorizationId,
      });
      say(db, actor.id, `Pagamento di ${formatEuro(amount)} rifiutato: ${result.reason}. Il limite della carta è ${formatEuro(card.limit_cents)}.`, row.id);
    });
    return { approved: false, reason: result.reason };
  }
  const recorded = recordCardTransaction(db, result.transaction);
  await deactivateCapturedCard(db, stripe!, card.stripe_card_id!, row.id);
  return { approved: true, transactionId: result.transaction.id, duplicate: recorded.duplicate };
}

// Disattivazione su Stripe dopo il primo pagamento catturato. Un errore non annulla il pagamento: resta nel registro.
export async function deactivateCapturedCard(db: DatabaseSync, stripe: StripeIssuing, stripeCardId: string, requestId: string | null) {
  try {
    await stripe.deactivateCard(stripeCardId);
  } catch (error) {
    logEvent(db, requestId, null, "card_deactivate_failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

// Registra un pagamento catturato (risposta API o webhook). Idempotente sull'id Stripe.
// La carta locale diventa inactive: chi chiama disattiva poi la carta su Stripe se `duplicate` è false.
export function recordCardTransaction(
  db: DatabaseSync,
  t: CapturedTransaction,
): { recorded: boolean; duplicate: boolean; requestId: string | null; stripeCardId: string } {
  return tx(db, () => {
    const card = db.prepare("SELECT * FROM cards WHERE stripe_card_id = ?").get(t.cardId) as unknown as CardRow | undefined;
    if (!card) return { recorded: false, duplicate: false, requestId: null, stripeCardId: t.cardId };
    const inserted = db
      .prepare(
        `INSERT INTO card_transactions (id, request_id, stripe_card_id, authorization_id, amount_cents, merchant_name,
           merchant_category, merchant_city, captured_at, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      )
      .run(
        t.id, card.request_id, t.cardId, t.authorizationId, t.amountCents, t.merchantName, t.merchantCategory,
        t.merchantCity, t.createdIso, JSON.stringify(t.raw ?? null),
      );
    if (Number(inserted.changes) === 0) return { recorded: true, duplicate: true, requestId: card.request_id, stripeCardId: t.cardId };
    const row = getRequest(db, card.request_id);
    db.prepare("UPDATE cards SET status = 'inactive', updated_at = ? WHERE id = ? AND status = 'active'").run(nowIso(), card.id);
    logEvent(db, row.id, null, "card_payment_captured", { transactionId: t.id, amountCents: t.amountCents, merchant: t.merchantName });
    const rule = categoryRule(row.category);
    say(
      db,
      row.user_id,
      `Pagato ${formatEuro(t.amountCents)} a ${t.merchantName}. Carica: scontrino${
        rule.requiresInvoice ? `, fattura intestata a ${COMPANY_BILLING.name}` : ""
      }.`,
      row.id,
    );
    return { recorded: true, duplicate: false, requestId: row.id, stripeCardId: t.cardId };
  });
}

// 3b. Documenti di spesa. Lo scontrino è sempre obbligatorio, la fattura solo per le categorie che la richiedono.
export interface DocumentInput {
  kind: DocumentKind;
  amountCents: number;
  merchant?: string | null;
  docDate?: string | null;
  vatNumber?: string | null;
  invoicedToCompany?: boolean | null;
  paymentMethod?: "card" | "cash" | "unknown";
  cardLast4?: string | null;
  transactionRef?: string | null;
  source: "upload" | "synthetic";
  filename?: string | null;
  mime?: string | null;
  path?: string | null;
  extracted?: unknown;
}

function attachDocumentTx(db: DatabaseSync, actor: Actor, requestId: unknown, input: DocumentInput): RequestRow {
  if (input?.kind !== "receipt" && input?.kind !== "invoice") throw new FlowError(400, "Tipo di documento non valido");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new FlowError(400, "Importo del documento non valido");
  if (input.source !== "upload" && input.source !== "synthetic") throw new FlowError(400, "Origine del documento non valida");
  const paymentMethod = input.paymentMethod ?? "unknown";
  if (!["card", "cash", "unknown"].includes(paymentMethod)) throw new FlowError(400, "Metodo di pagamento non valido");

  const row = getRequest(db, requestId);
  if (row.user_id !== actor.id) throw new FlowError(403, "Puoi caricare documenti solo per le tue richieste");
  const waiting =
    (row.status === "approved" && row.authorized_cents !== null) ||
    (row.status === "rejected" && row.funding === "personal" && (row.authorized_cents ?? 0) > 0);
  if (!waiting) throw new FlowError(409, "La pratica non attende documenti");
  const transaction = row.funding === "card" ? transactionOf(db, row.id) : undefined;
  if (row.funding === "card" && !transaction) throw new FlowError(409, "I documenti si caricano dopo il pagamento con la carta");
  if (documentsOf(db, row.id).some((d) => d.kind === input.kind)) throw new FlowError(409, "Documento già caricato");

  db.prepare(
    `INSERT INTO documents (id, request_id, kind, amount_cents, merchant, doc_date, vat_number, invoiced_to_company,
       payment_method, card_last4, transaction_ref, source, filename, mime, path, extracted_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(), row.id, input.kind, input.amountCents, input.merchant ?? null, input.docDate ?? null, input.vatNumber ?? null,
    input.invoicedToCompany === undefined || input.invoicedToCompany === null ? null : input.invoicedToCompany ? 1 : 0,
    paymentMethod, input.cardLast4 ?? null, input.transactionRef ?? null, input.source, input.filename ?? null, input.mime ?? null, input.path ?? null,
    input.extracted === undefined ? null : JSON.stringify(input.extracted),
  );
  logEvent(db, row.id, actor.id, "document_attached", { kind: input.kind, amountCents: input.amountCents, source: input.source });

  const missing = missingKinds(db, row);
  if (missing.length > 0) {
    say(db, actor.id, `Documento ricevuto. Manca ancora: ${missing.map((k) => (k === "invoice" ? "fattura" : "scontrino")).join(", ")}.`, row.id);
    return getRequest(db, row.id);
  }

  const docs = documentsOf(db, row.id);
  const receipt = docs.find((d) => d.kind === "receipt")!;
  const authorized = row.authorized_cents!;
  const spent = receipt.amount_cents;
  const { outcome, reimbursed, checks } = reconcile({
    funding: row.funding,
    authorizedCents: authorized,
    requiresInvoice: categoryRule(row.category).requiresInvoice,
    receipt,
    invoice: docs.find((d) => d.kind === "invoice"),
    transaction,
    cardLast4: cardOf(db, row.id)?.last4 ?? null,
  });
  const failed = checks.filter((c) => !c.ok);
  const autoApproved = failed.length === 0;

  const raw = {
    receiptId: `R-${row.id.slice(0, 8).toUpperCase()}`,
    tripId: row.trip_id,
    category: row.category,
    amountCents: spent,
    currency: "EUR",
    transactionId: transaction?.id ?? null,
    checks,
  };
  db.prepare(
    "INSERT INTO receipts (id, request_id, amount_cents, outcome, raw_json, reimbursed_cents) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), row.id, spent, outcome, JSON.stringify(raw), reimbursed);
  logEvent(db, row.id, actor.id, "receipt_verified", {
    receiptId: raw.receiptId,
    receiptCents: spent,
    authorizedCents: authorized,
    outcome,
    reimbursedCents: reimbursed,
    funding: row.funding,
    checks,
  });

  if (autoApproved) {
    // Tutto combacia: l'agente di verifica approva al posto di Finance. Una sola decisione per pratica (UNIQUE).
    db.prepare("INSERT INTO approvals (request_id, kind, decision, decided_by, channel) VALUES (?, 'finance', 'approved', NULL, 'agent')").run(row.id);
    setStatus(db, row.id, "finance_approved");
    logEvent(db, row.id, null, "finance_auto_approved", { checks: checks.map((c) => c.id) });
    const refund = row.funding === "card" ? "" : ` Rimborso di ${formatEuro(reimbursed ?? spent)} a fine mese.`;
    const capped = outcome === "capped" ? ` L'eccedenza di ${formatEuro(spent - authorized)} resta a tuo carico.` : "";
    say(db, actor.id, `Documenti verificati: ${checks.length} controlli superati. Rimborso approvato in automatico.${refund}${capped}`, row.id);
    for (const financeId of usersWith(db, "finance")) {
      say(db, financeId, `Pratica di ${actor.name} approvata in automatico: documento ${formatEuro(spent)}, autorizzato ${formatEuro(authorized)}. CSV disponibile.`, row.id);
    }
  } else {
    setStatus(db, row.id, "in_review");
    const reasons = failed.map((c) => c.detail).join("; ");
    if (failed.some((c) => c.id === "invoice_company")) {
      logEvent(db, row.id, actor.id, "invoice_not_company", { expected: COMPANY_BILLING.name, vatNumber: docs.find((d) => d.kind === "invoice")?.vat_number ?? null });
    }
    say(db, actor.id, `Documenti ricevuti, ma qualcosa non combacia: ${reasons}. La pratica resta in revisione.`, row.id);
    const next = outcome === "over_authorized" ? "Serve una deroga integrativa del manager." : "Controlla i documenti e approva o lascia in revisione.";
    for (const financeId of usersWith(db, "finance")) {
      say(db, financeId, `Pratica di ${actor.name} da rivedere: ${reasons}. ${next}`, row.id);
    }
  }
  return getRequest(db, row.id);
}

export interface ReconCheck {
  id: "within_authorized" | "transaction_amount" | "transaction_date" | "card_last4" | "transaction_ref" | "invoice_company" | "invoice_amount";
  ok: boolean;
  detail: string;
}

export interface ReconInput {
  funding: Funding | null;
  authorizedCents: number;
  requiresInvoice: boolean;
  receipt: Pick<DocumentRow, "amount_cents" | "doc_date" | "card_last4" | "transaction_ref">;
  invoice?: Pick<DocumentRow, "amount_cents" | "invoiced_to_company">;
  transaction?: Pick<CardTransactionRow, "id" | "authorization_id" | "amount_cents" | "captured_at">;
  cardLast4: string | null;
}

// Giorni di scarto ammessi tra la data dello scontrino e quella della transazione (fusi orari, corse notturne).
export const RECEIPT_DATE_TOLERANCE_DAYS = 2;

// Riconciliazione deterministica dei dati estratti dal modello: scontrino, fattura e transazione della carta.
// Il modello legge i documenti, qui il server confronta. Se un controllo fallisce la pratica va in revisione a Finance.
// Un dato non stampato (ultime cifre, riferimento) non blocca; un dato stampato e diverso sì.
export function reconcile(input: ReconInput): { outcome: ReceiptOutcome; reimbursed: number | null; checks: ReconCheck[] } {
  const { funding, authorizedCents: authorized, receipt, invoice, transaction } = input;
  const spent = receipt.amount_cents;
  const checks: ReconCheck[] = [];

  if (funding === "personal") {
    // Carta personale: il rimborso è min(scontrino, residuo), l'eccedenza è a carico del dipendente per regola.
    checks.push({
      id: "within_authorized",
      ok: true,
      detail: spent <= authorized ? `scontrino ${formatEuro(spent)} entro il residuo` : `rimborso limitato a ${formatEuro(authorized)}`,
    });
  } else {
    checks.push({
      id: "within_authorized",
      ok: spent <= authorized,
      detail: spent <= authorized ? `scontrino ${formatEuro(spent)} entro l'autorizzato` : `lo scontrino da ${formatEuro(spent)} supera i ${formatEuro(authorized)} autorizzati`,
    });
  }

  if (funding === "card" && transaction) {
    const sameAmount = spent === transaction.amount_cents;
    checks.push({
      id: "transaction_amount",
      ok: sameAmount,
      detail: sameAmount ? "importo uguale alla transazione" : `lo scontrino da ${formatEuro(spent)} non corrisponde al pagamento di ${formatEuro(transaction.amount_cents)}`,
    });
    const paidOn = transaction.captured_at.slice(0, 10);
    const days = receipt.doc_date ? Math.abs(Date.parse(receipt.doc_date) - Date.parse(paidOn)) / DAY_MS : NaN;
    checks.push({
      id: "transaction_date",
      ok: days <= RECEIPT_DATE_TOLERANCE_DAYS,
      detail: !receipt.doc_date
        ? "data dello scontrino non leggibile"
        : days <= RECEIPT_DATE_TOLERANCE_DAYS
          ? "data coerente con il pagamento"
          : `lo scontrino è del ${receipt.doc_date}, il pagamento del ${paidOn}`,
    });
    if (receipt.card_last4) {
      const ok = receipt.card_last4 === input.cardLast4;
      checks.push({ id: "card_last4", ok, detail: ok ? `carta **** ${receipt.card_last4}` : `lo scontrino riporta la carta **** ${receipt.card_last4}, non quella della pratica` });
    }
    if (receipt.transaction_ref) {
      const ref = normalizeRef(receipt.transaction_ref);
      const known = [transaction.id, transaction.authorization_id].map(normalizeRef).filter((k) => k.length >= 4);
      const ok = ref.length >= 4 && known.some((k) => k === ref || k.endsWith(ref) || ref.endsWith(k));
      checks.push({ id: "transaction_ref", ok, detail: ok ? "riferimento della transazione corrispondente" : `il riferimento ${receipt.transaction_ref} non corrisponde alla transazione` });
    }
  }

  if (input.requiresInvoice) {
    const company = invoice?.invoiced_to_company === 1;
    checks.push({
      id: "invoice_company",
      ok: company,
      detail: company
        ? `fattura intestata a ${COMPANY_BILLING.name}`
        : invoice?.invoiced_to_company === 0
          ? `la fattura non è intestata a ${COMPANY_BILLING.name}`
          : "intestatario della fattura non leggibile",
    });
    if (invoice) {
      const same = invoice.amount_cents === spent;
      checks.push({
        id: "invoice_amount",
        ok: same,
        detail: same ? "fattura e scontrino con lo stesso importo" : `la fattura da ${formatEuro(invoice.amount_cents)} non corrisponde allo scontrino da ${formatEuro(spent)}`,
      });
    }
  }

  let outcome: ReceiptOutcome;
  let reimbursed: number | null;
  if (funding === "card") {
    outcome = spent > authorized ? "over_authorized" : checks.every((c) => c.ok) ? "match" : "mismatch";
    reimbursed = 0;
  } else if (funding === "personal") {
    outcome = spent <= authorized ? "match" : "capped";
    reimbursed = Math.min(spent, authorized);
  } else {
    outcome = spent <= authorized ? (checks.every((c) => c.ok) ? "match" : "mismatch") : "over_authorized";
    reimbursed = spent <= authorized ? spent : null;
  }
  return { outcome, reimbursed, checks };
}

// Pre-validazione leggera (prima di chiamare il modello sul file): proprietario, stato e documento non ancora presente.
export function assertCanAttach(db: DatabaseSync, actorId: unknown, requestId: unknown, kind: unknown): RequestRow {
  const actor = getActor(db, actorId, "employee");
  if (kind !== "receipt" && kind !== "invoice") throw new FlowError(400, "Tipo di documento non valido");
  const row = getRequest(db, requestId);
  if (row.user_id !== actor.id) throw new FlowError(403, "Puoi caricare documenti solo per le tue richieste");
  const waiting =
    (row.status === "approved" && row.authorized_cents !== null) ||
    (row.status === "rejected" && row.funding === "personal" && (row.authorized_cents ?? 0) > 0);
  if (!waiting) throw new FlowError(409, "La pratica non attende documenti");
  if (row.funding === "card" && !transactionOf(db, row.id)) throw new FlowError(409, "I documenti si caricano dopo il pagamento con la carta");
  if (kind === "invoice" && !categoryRule(row.category).requiresInvoice) throw new FlowError(409, "Per questa categoria la fattura non è richiesta");
  if (documentsOf(db, row.id).some((d) => d.kind === kind)) throw new FlowError(409, "Documento già caricato");
  return row;
}

export function attachDocument(db: DatabaseSync, actorId: unknown, requestId: unknown, input: DocumentInput): RequestRow {
  const actor = getActor(db, actorId, "employee");
  return tx(db, () => attachDocumentTx(db, actor, requestId, input));
}

// Demo: documenti sintetici costruiti sulla pratica. «exact» è pari all'importo base (transazione con carta,
// altrimenti autorizzato), «over» lo supera di 6 €. Passa dagli stessi controlli di un caricamento reale.
export function attachReceipt(db: DatabaseSync, actorId: unknown, requestId: unknown, kind: unknown): RequestRow {
  const actor = getActor(db, actorId, "employee");
  if (kind !== "exact" && kind !== "over") throw new FlowError(400, "Tipo di ricevuta sconosciuto");

  return tx(db, () => {
    const row = getRequest(db, requestId);
    if (row.user_id !== actor.id) throw new FlowError(403, "Puoi caricare ricevute solo per le tue richieste");
    if (row.authorized_cents === null) throw new FlowError(409, "La pratica non attende una ricevuta");
    const base = row.funding === "card" ? transactionOf(db, row.id)?.amount_cents : row.authorized_cents;
    if (base === undefined) throw new FlowError(409, "I documenti si caricano dopo il pagamento con la carta");
    const amountCents = base + (kind === "over" ? RECEIPT_OVER_CENTS : 0);
    const rule = categoryRule(row.category);
    const docDate = nowIso().slice(0, 10);
    const transaction = transactionOf(db, row.id);
    const synthetic = {
      amountCents,
      merchant: transaction?.merchant_name ?? "Fornitore demo",
      docDate,
      cardLast4: row.funding === "card" ? cardOf(db, row.id)?.last4 ?? null : null,
      transactionRef: transaction?.authorization_id ?? null,
      source: "synthetic" as const,
    };
    if (rule.requiresInvoice) {
      attachDocumentTx(db, actor, row.id, {
        ...synthetic,
        kind: "invoice",
        vatNumber: "IT09876543210",
        invoicedToCompany: true,
        paymentMethod: row.funding === "card" ? "card" : "unknown",
      });
    }
    return attachDocumentTx(db, actor, row.id, { ...synthetic, kind: "receipt", paymentMethod: row.funding === "card" ? "card" : "unknown" });
  });
}

// Per la UI: carta, transazione e documenti di una pratica.
export function cardView(db: DatabaseSync, requestId: unknown) {
  const request = getRequest(db, requestId);
  const rule = categoryRule(request.category);
  const documents = documentsOf(db, request.id);
  const required = requiredKinds(rule);
  return {
    request,
    card: cardOf(db, request.id) ?? null,
    transaction: transactionOf(db, request.id) ?? null,
    documents,
    required,
    missing: required.filter((k) => !documents.some((d) => d.kind === k)),
    rule,
    billing: rule.requiresInvoice ? COMPANY_BILLING : null,
  };
}

// Tutto ciò che serve al PDF del ticket per Finance.
export function ticketData(db: DatabaseSync, actorId: unknown, requestId: unknown): TicketData {
  getActor(db, actorId, "finance");
  const request = getRequest(db, requestId);
  const receipt = db.prepare("SELECT * FROM receipts WHERE request_id = ?").get(request.id) as unknown as ReceiptRow | undefined;
  if (!receipt) throw new FlowError(409, "Ticket disponibile dopo la verifica dei documenti");
  const employee = db.prepare("SELECT id, name FROM roles_and_users WHERE id = ?").get(request.user_id) as unknown as {
    id: string;
    name: string;
  };
  const decisions = db
    .prepare(
      `SELECT a.kind, a.decision, COALESCE(u.name, '${AGENT_NAME}') AS by, a.channel, a.decided_at AS at
       FROM approvals a LEFT JOIN roles_and_users u ON u.id = a.decided_by WHERE a.request_id = ? ORDER BY a.id`,
    )
    .all(request.id) as unknown as TicketData["decisions"];
  const rule = categoryRule(request.category);
  const card = cardOf(db, request.id);
  const transaction = transactionOf(db, request.id);
  return {
    request: {
      id: request.id,
      category: request.category,
      categoryLabel: rule.label,
      requestedCents: request.amount_cents,
      residualCents: request.budget_cents,
      extraCents: request.extra_cents,
      authorizedCents: request.authorized_cents,
      status: request.status,
      funding: request.funding,
      reason: request.reason,
      policyQuote: request.clause_quote,
      policyVersion: request.policy_version,
    },
    employee: { id: employee.id, name: employee.name, email: userEmail(employee.name) },
    decisions,
    requirements: { receiptLabel: rule.receiptLabel, requiresInvoice: rule.requiresInvoice, invoiceNote: rule.invoiceNote },
    card: card?.last4 ? { last4: card.last4, limitCents: card.limit_cents, allowedCategories: JSON.parse(card.allowed_categories) } : null,
    transaction: transaction
      ? {
          id: transaction.id,
          merchantName: transaction.merchant_name,
          merchantCategory: transaction.merchant_category,
          merchantCity: transaction.merchant_city,
          amountCents: transaction.amount_cents,
          capturedAt: transaction.captured_at,
        }
      : null,
    documents: documentsOf(db, request.id).map((d) => ({
      kind: d.kind,
      amountCents: d.amount_cents,
      merchant: d.merchant,
      docDate: d.doc_date,
      vatNumber: d.vat_number,
      invoicedToCompany: d.invoiced_to_company === null ? null : d.invoiced_to_company === 1,
      paymentMethod: d.payment_method,
      source: d.source,
      path: d.path,
      mime: d.mime,
    })),
    verification: { outcome: receipt.outcome, receiptCents: receipt.amount_cents, reimbursedCents: receipt.reimbursed_cents },
    company: { ...COMPANY_BILLING },
  };
}

// Controlli salvati con la verifica (raw_json della ricevuta). Le pratiche vecchie non li hanno.
export function checksOf(rawJson: string): ReconCheck[] {
  try {
    const checks = JSON.parse(rawJson)?.checks;
    return Array.isArray(checks) ? checks : [];
  } catch {
    return [];
  }
}

// Stessa regola di financeApprove, per mostrare il pulsante.
export function canFinanceApprove(status: Status, outcome: ReceiptOutcome | null): boolean {
  return status === "pending_finance" || (status === "in_review" && outcome !== null && outcome !== "over_authorized");
}

// 4. Finance approva il rimborso. Solo dopo, il server abilita il CSV.
export function financeApprove(db: DatabaseSync, actorId: unknown, requestId: unknown): { request: RequestRow; duplicate: boolean } {
  const actor = getActor(db, actorId, "finance");
  return tx(db, () => {
    const row = getRequest(db, requestId);
    const already = db.prepare("SELECT 1 AS ok FROM approvals WHERE request_id = ? AND kind = 'finance'").get(row.id);
    if (already) return { request: row, duplicate: true };
    if (row.status !== "pending_finance" && row.status !== "in_review") throw new FlowError(409, "La pratica non è in coda Finance");
    if (row.status === "in_review") {
      const receipt = db.prepare("SELECT outcome FROM receipts WHERE request_id = ?").get(row.id) as { outcome: ReceiptOutcome } | undefined;
      if (!receipt) throw new FlowError(409, "Documenti non ancora verificati");
      // La ricevuta oltre l'autorizzato si ferma: serve una deroga integrativa del manager, non basta Finance.
      if (receipt.outcome === "over_authorized") throw new FlowError(409, "La ricevuta supera l'autorizzato: serve una deroga integrativa del manager");
    }
    db.prepare("INSERT INTO approvals (request_id, kind, decision, decided_by, channel) VALUES (?, 'finance', 'approved', ?, 'web')").run(
      row.id,
      actor.id,
    );
    setStatus(db, row.id, "finance_approved");
    logEvent(db, row.id, actor.id, "finance_approved", { afterReview: row.status === "in_review" });
    say(db, row.user_id, `${actor.name} (Finance) ha approvato il rimborso.`, row.id);
    say(db, actor.id, "Rimborso approvato. Ora puoi scaricare il CSV.", row.id);
    return { request: getRequest(db, row.id), duplicate: false };
  });
}

function csvCell(value: string | number): string {
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// 5. Export CSV: bloccato finché Finance non ha approvato.
export function exportCsv(db: DatabaseSync, actorId: unknown, requestId: unknown): { filename: string; csv: string } {
  const actor = getActor(db, actorId, "finance");
  return tx(db, () => {
    const row = getRequest(db, requestId);
    if (row.status !== "finance_approved" && row.status !== "exported") {
      throw new FlowError(409, "Export bloccato: serve prima l'approvazione di Finance");
    }
    const data = db
      .prepare(
        `SELECT e.name AS employee, rc.amount_cents AS receipt_cents, rc.raw_json AS raw_json, rc.reimbursed_cents AS reimbursed_cents,
                (SELECT ct.id FROM card_transactions ct WHERE ct.request_id = r.id ORDER BY ct.captured_at, ct.id LIMIT 1) AS card_transaction_id,
                (SELECT m.name FROM approvals a JOIN roles_and_users m ON m.id = a.decided_by WHERE a.request_id = r.id AND a.kind = 'manager') AS manager,
                (SELECT COALESCE(f.name, '${AGENT_NAME}') FROM approvals a LEFT JOIN roles_and_users f ON f.id = a.decided_by WHERE a.request_id = r.id AND a.kind = 'finance') AS finance
         FROM requests r
         JOIN roles_and_users e ON e.id = r.user_id
         JOIN receipts rc ON rc.request_id = r.id
         WHERE r.id = ?`,
      )
      .get(row.id) as unknown as
      | {
          employee: string;
          receipt_cents: number;
          raw_json: string;
          reimbursed_cents: number | null;
          card_transaction_id: string | null;
          manager: string | null;
          finance: string | null;
        }
      | undefined;
    if (!data) throw new FlowError(409, "Ricevuta mancante");

    const header = ["request_id", "trip_id", "employee", "category", "amount_cents", "amount_eur", "receipt_id", "manager", "finance", "policy_version", "clause", "funding", "reimbursed_cents", "card_transaction_id"];
    const line = [
      row.id,
      row.trip_id,
      data.employee,
      row.category,
      data.receipt_cents,
      (data.receipt_cents / 100).toFixed(2),
      JSON.parse(data.raw_json).receiptId,
      data.manager ?? "",
      data.finance ?? "",
      row.policy_version,
      row.clause_id,
      row.funding ?? "",
      data.reimbursed_cents ?? "",
      data.card_transaction_id ?? "",
    ];
    if (row.status === "finance_approved") setStatus(db, row.id, "exported");
    logEvent(db, row.id, actor.id, "csv_exported", { amountCents: data.receipt_cents });
    return { filename: `rimborso-${row.id}.csv`, csv: `${header.join(",")}\n${line.map(csvCell).join(",")}\n` };
  });
}

// Telegram: il codice monouso collega una chat a un utente. Il ruolo resta quello del database.
export function createLinkCode(db: DatabaseSync, actorId: unknown): { code: string; expiresAt: string } {
  const actor = getActor(db, actorId);
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = Array.from({ length: 6 }, () => LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)]).join("");
    try {
      db.prepare("INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)").run(code, actor.id, expiresAt);
      logEvent(db, null, actor.id, "telegram_code_issued", {});
      return { code, expiresAt };
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
  throw new FlowError(500, "Codice non generato");
}

// Lo userà il bot quando riceve il codice. Restituisce l'utente collegato.
export function redeemLinkCode(db: DatabaseSync, code: unknown, chatId: unknown): Actor {
  if (typeof code !== "string" || typeof chatId !== "string" || !chatId) throw new FlowError(400, "Codice o chat non validi");
  const normalized = code.trim().toUpperCase();
  return tx(db, () => {
    const row = db
      .prepare("SELECT user_id, expires_at, used_at FROM telegram_link_codes WHERE code = ?")
      .get(normalized) as unknown as { user_id: string; expires_at: string; used_at: string | null } | undefined;
    if (!row) throw new FlowError(404, "Codice non valido");
    if (row.used_at) throw new FlowError(409, "Codice già usato");
    if (row.expires_at < nowIso()) throw new FlowError(410, "Codice scaduto");
    const actor = getActor(db, row.user_id);
    const current = db.prepare("SELECT telegram_chat_id FROM roles_and_users WHERE id = ?").get(actor.id)?.telegram_chat_id;
    if (current && current !== chatId) throw new FlowError(409, "Utente già collegato a un'altra chat");
    try {
      db.prepare("UPDATE roles_and_users SET telegram_chat_id = ? WHERE id = ?").run(chatId, actor.id);
    } catch {
      throw new FlowError(409, "Chat già collegata a un altro utente");
    }
    db.prepare("UPDATE telegram_link_codes SET used_at = ? WHERE code = ?").run(nowIso(), normalized);
    logEvent(db, null, actor.id, "telegram_linked", {});
    return actor;
  });
}

// Riporta lo scenario ai 30 € residui. Mantiene utenti e collegamenti Telegram.
export function resetDemo(db: DatabaseSync) {
  tx(db, () => {
    for (const table of ["events", "card_transactions", "documents", "cards", "receipts", "approvals", "requests", "chat_messages", "telegram_link_codes"]) {
      db.exec(`DELETE FROM ${table}`);
    }
    db.prepare("UPDATE trips SET remaining_budget_cents = 3000 WHERE id = ?").run(DEMO_TRIP_ID);
    logEvent(db, null, null, "demo_reset", {});
  });
}

// Letture per la chat e per il contesto dell'agente.
export function listRequests(db: DatabaseSync, filter: { statuses?: Status[]; userId?: string; ids?: string[] } = {}): RequestView[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.statuses?.length) {
    where.push(`r.status IN (${filter.statuses.map(() => "?").join(", ")})`);
    params.push(...filter.statuses);
  }
  if (filter.userId) {
    where.push("r.user_id = ?");
    params.push(filter.userId);
  }
  if (filter.ids) {
    if (filter.ids.length === 0) return [];
    where.push(`r.id IN (${filter.ids.map(() => "?").join(", ")})`);
    params.push(...filter.ids);
  }
  const rows = db
    .prepare(
      `SELECT r.*, e.name AS employee_name, e.role AS employee_role FROM requests r
       JOIN roles_and_users e ON e.id = r.user_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY r.priority DESC, r.created_at ASC`,
    )
    .all(...params) as unknown as (RequestRow & { employee_name: string; employee_role: string })[];
  return rows.map((row) => ({ ...row, priority_label: PRIORITY_LABELS[row.priority] ?? String(row.priority) }));
}

export interface EventRow {
  id: number;
  request_id: string | null;
  type: string;
  payload: string;
  created_at: string;
  actor_name: string | null;
}

// Il dipendente vede solo gli eventi delle proprie pratiche. Manager e Finance vedono tutto il registro.
export function listEvents(db: DatabaseSync, actor: Actor, limit = 15): EventRow[] {
  const scope = actor.permission === "employee" ? "WHERE ev.request_id IN (SELECT id FROM requests WHERE user_id = ?)" : "";
  return db
    .prepare(
      `SELECT ev.id, ev.request_id, ev.type, ev.payload, ev.created_at, a.name AS actor_name
       FROM events ev LEFT JOIN roles_and_users a ON a.id = ev.actor_id
       ${scope} ORDER BY ev.id DESC LIMIT ?`,
    )
    .all(...(actor.permission === "employee" ? [actor.id, limit] : [limit])) as unknown as EventRow[];
}

export interface MessageRow {
  id: number;
  role: "user" | "assistant";
  content: string;
  card: string | null;
  request_id: string | null;
  created_at: string;
}

export function listMessages(db: DatabaseSync, userId: string, limit = 60): MessageRow[] {
  const rows = db
    .prepare("SELECT id, role, content, card, request_id, created_at FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .all(userId, limit) as unknown as MessageRow[];
  return rows.reverse();
}
