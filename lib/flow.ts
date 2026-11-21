import { randomInt, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DEMO_TRIP_ID } from "./db.ts";
import { formatEuro } from "./format.ts";
import { readPolicy, type Category } from "./policy.ts";
import { verifyProposal, type Urgency, type VerifiedProposal } from "./proposal.ts";

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
  created_at: string;
  updated_at: string;
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
  | { type: "policy"; version: string };

const COMMITTED_STATUSES = "'approved', 'in_review', 'pending_finance', 'finance_approved', 'exported'";
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
       WHERE user_id = ? AND trip_id = ? AND category = ? AND status IN (${COMMITTED_STATUSES})`,
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

// 1. Il dipendente conferma la proposta dell'agente. Il server la rilegge dalla chat, la riverifica sulla
// policy corrente e ricalcola tutto: il client manda solo l'id del messaggio.
export function confirmProposal(
  db: DatabaseSync,
  actorId: unknown,
  messageId: unknown,
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
      say(db, actor.id, `Spesa di ${formatEuro(proposal.amountCents)} autorizzata: rientra nel tuo limite. Quando hai la ricevuta, caricala qui sotto.`, id);
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
    if (decision === "approved") setStatus(db, row.id, "approved", row.amount_cents);
    else setStatus(db, row.id, "rejected");
    logEvent(db, row.id, actor.id, decision === "approved" ? "manager_approved" : "manager_rejected", {
      channel,
      authorizedCents: authorized,
      extraCents: row.extra_cents,
    });
    say(
      db,
      row.user_id,
      decision === "approved"
        ? `${actor.name} ha approvato fino a ${formatEuro(row.amount_cents)}. Quando hai la ricevuta, caricala qui sotto.`
        : `${actor.name} ha rifiutato la deroga.`,
      row.id,
    );
    say(db, actor.id, decision === "approved" ? "Approvata." : "Rifiutata.", row.id);
    return { request: getRequest(db, row.id), duplicate: false };
  });
}

// 3. Arriva la ricevuta sintetica, costruita sulla pratica: «exact» è pari all'autorizzato, «over» lo supera di 6 €.
// Il server collega la ricevuta alla pratica e confronta l'importo con l'autorizzato.
export function attachReceipt(db: DatabaseSync, actorId: unknown, requestId: unknown, kind: unknown): RequestRow {
  const actor = getActor(db, actorId, "employee");
  if (kind !== "exact" && kind !== "over") throw new FlowError(400, "Tipo di ricevuta sconosciuto");

  return tx(db, () => {
    const row = getRequest(db, requestId);
    if (row.user_id !== actor.id) throw new FlowError(403, "Puoi caricare ricevute solo per le tue richieste");
    if (row.status !== "approved" || row.authorized_cents === null) {
      throw new FlowError(409, "La pratica non attende una ricevuta");
    }
    const raw = {
      receiptId: `R-${row.id.slice(0, 8).toUpperCase()}`,
      tripId: row.trip_id,
      category: row.category,
      amountCents: row.authorized_cents + (kind === "over" ? RECEIPT_OVER_CENTS : 0),
      currency: "EUR",
    };
    const rawText = JSON.stringify(raw);

    const outcome = raw.amountCents <= row.authorized_cents ? "match" : "over_authorized";
    db.prepare("INSERT INTO receipts (id, request_id, amount_cents, outcome, raw_json) VALUES (?, ?, ?, ?, ?)").run(
      randomUUID(),
      row.id,
      raw.amountCents,
      outcome,
      rawText,
    );
    setStatus(db, row.id, outcome === "match" ? "pending_finance" : "in_review");
    logEvent(db, row.id, actor.id, "receipt_verified", {
      receiptId: raw.receiptId,
      receiptCents: raw.amountCents,
      authorizedCents: row.authorized_cents,
      outcome,
    });
    if (outcome === "match") {
      say(db, actor.id, `Ricevuta da ${formatEuro(raw.amountCents)} verificata: corrisponde all'importo autorizzato. La pratica passa a Finance.`, row.id);
      for (const financeId of usersWith(db, "finance")) {
        say(db, financeId, `Pratica di ${actor.name} verificata: ricevuta ${formatEuro(raw.amountCents)}, autorizzato ${formatEuro(row.authorized_cents)}.`, row.id);
      }
    } else {
      say(
        db,
        actor.id,
        `La ricevuta da ${formatEuro(raw.amountCents)} supera i ${formatEuro(row.authorized_cents)} autorizzati. La pratica resta in revisione.`,
        row.id,
      );
    }
    return getRequest(db, row.id);
  });
}

// 4. Finance approva il rimborso. Solo dopo, il server abilita il CSV.
export function financeApprove(db: DatabaseSync, actorId: unknown, requestId: unknown): { request: RequestRow; duplicate: boolean } {
  const actor = getActor(db, actorId, "finance");
  return tx(db, () => {
    const row = getRequest(db, requestId);
    if (row.status !== "pending_finance") {
      const already = db.prepare("SELECT 1 AS ok FROM approvals WHERE request_id = ? AND kind = 'finance'").get(row.id);
      if (already) return { request: row, duplicate: true };
      throw new FlowError(409, "La pratica non è in coda Finance");
    }
    db.prepare("INSERT INTO approvals (request_id, kind, decision, decided_by, channel) VALUES (?, 'finance', 'approved', ?, 'web')").run(
      row.id,
      actor.id,
    );
    setStatus(db, row.id, "finance_approved");
    logEvent(db, row.id, actor.id, "finance_approved", {});
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
        `SELECT e.name AS employee, rc.amount_cents AS receipt_cents, rc.raw_json AS raw_json,
                (SELECT m.name FROM approvals a JOIN roles_and_users m ON m.id = a.decided_by WHERE a.request_id = r.id AND a.kind = 'manager') AS manager,
                (SELECT f.name FROM approvals a JOIN roles_and_users f ON f.id = a.decided_by WHERE a.request_id = r.id AND a.kind = 'finance') AS finance
         FROM requests r
         JOIN roles_and_users e ON e.id = r.user_id
         JOIN receipts rc ON rc.request_id = r.id
         WHERE r.id = ?`,
      )
      .get(row.id) as unknown as
      | { employee: string; receipt_cents: number; raw_json: string; manager: string | null; finance: string | null }
      | undefined;
    if (!data) throw new FlowError(409, "Ricevuta mancante");

    const header = ["request_id", "trip_id", "employee", "category", "amount_cents", "amount_eur", "receipt_id", "manager", "finance", "policy_version", "clause"];
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
    for (const table of ["events", "receipts", "approvals", "requests", "chat_messages", "telegram_link_codes"]) {
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
