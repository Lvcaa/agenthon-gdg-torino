import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  AGENT_NAME,
  FlowError,
  canFinanceApprove,
  cardView,
  checksOf,
  getActor,
  listRequests,
  type DocumentKind,
  type DocumentRow,
  type ReconCheck,
  type ReceiptOutcome,
  type RequestView,
  type Status,
} from "./flow.ts";
import { URGENCIES, type Urgency } from "./proposal.ts";
import type { TicketData } from "./ticket-pdf.ts";

// Letture per le sezioni di ogni ruolo (le mie richieste, coda del manager, archivio di Finance).
// Ogni funzione rilegge il permesso dal database: l'interfaccia non decide cosa mostrare.

// --- Dipendente: «Le mie richieste» ---

export type EmployeeTab = "open" | "done";

export interface EmployeeRequest extends RequestView {
  // Documenti obbligatori ancora da caricare (la fattura solo per le categorie che la richiedono).
  missing: DocumentKind[];
  // La pratica è in una fase in cui i documenti si possono caricare (dopo il pagamento, se con carta).
  canUpload: boolean;
}

const DONE_STATUSES: Status[] = ["finance_approved", "exported"];

// Una pratica è completata quando Finance l'ha approvata, oppure quando è rifiutata senza alcun rimborso.
// Un rifiuto con residuo resta in corso: il dipendente paga con la sua carta e deve caricare lo scontrino.
export function employeeBucket(r: RequestView): EmployeeTab {
  if (DONE_STATUSES.includes(r.status)) return "done";
  if (r.status === "rejected" && !(r.funding === "personal" && (r.authorized_cents ?? 0) > 0)) return "done";
  return "open";
}

function expectsDocuments(r: RequestView): boolean {
  return (r.status === "approved" && r.authorized_cents !== null) || (r.status === "rejected" && r.funding === "personal" && (r.authorized_cents ?? 0) > 0);
}

export function employeeRequests(db: DatabaseSync, actorId: unknown, tab: EmployeeTab): EmployeeRequest[] {
  const actor = getActor(db, actorId, "employee");
  return listRequests(db, { userId: actor.id })
    .filter((r) => employeeBucket(r) === tab)
    .map((r) => {
      const v = cardView(db, r.id);
      const expects = expectsDocuments(r);
      return {
        ...r,
        missing: expects ? v.missing : [],
        canUpload: expects && (r.funding !== "card" || v.transaction !== null) && v.missing.length > 0,
      };
    })
    .sort((a, b) => b.missing.length - a.missing.length || b.created_at.localeCompare(a.created_at));
}

// --- Manager: coda e decisioni ---

export function parseUrgency(value: unknown): Urgency | null {
  return URGENCIES.includes(value as Urgency) ? (value as Urgency) : null;
}

// In attesa di decisione, ordinate per priorità. Il manager non vede le proprie richieste.
export function managerQueue(db: DatabaseSync, actorId: unknown, urgency: Urgency | null = null): RequestView[] {
  const actor = getActor(db, actorId, "manager");
  return listRequests(db, { statuses: ["pending_manager"] }).filter((r) => r.user_id !== actor.id && (!urgency || r.urgency === urgency));
}

export interface DecidedRequest extends RequestView {
  decided_by: string;
  decided_at: string;
  channel: string;
}

// Decisioni dei manager (nessun team nel prototipo: tutte). Le pratiche approvate in automatico non compaiono.
export function managerDecisions(db: DatabaseSync, actorId: unknown, decision: "approved" | "rejected"): DecidedRequest[] {
  getActor(db, actorId, "manager");
  const rows = db
    .prepare(
      `SELECT a.request_id, u.name AS decided_by, a.decided_at, a.channel FROM approvals a
       JOIN roles_and_users u ON u.id = a.decided_by
       WHERE a.kind = 'manager' AND a.decision = ? ORDER BY a.decided_at DESC, a.id DESC`,
    )
    .all(decision) as unknown as { request_id: string; decided_by: string; decided_at: string; channel: string }[];
  const byId = new Map(listRequests(db, { ids: rows.map((r) => r.request_id) }).map((r) => [r.id, r]));
  return rows.flatMap((row) => {
    const r = byId.get(row.request_id);
    return r ? [{ ...r, decided_by: row.decided_by, decided_at: row.decided_at, channel: row.channel }] : [];
  });
}

// --- Finance: ricerca per persona e archivio delle note spese ---

export interface PersonSummary {
  id: string;
  name: string;
  role: string;
  requests: number;
  authorized_cents: number;
}

// Dipendenti il cui nome contiene `query` (maiuscole indifferenti), con numero di pratiche e totale autorizzato.
export function financePeople(db: DatabaseSync, actorId: unknown, query = ""): PersonSummary[] {
  getActor(db, actorId, "finance");
  const pattern = `%${query.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db
    .prepare(
      `SELECT u.id, u.name, u.role, COUNT(r.id) AS requests, COALESCE(SUM(r.authorized_cents), 0) AS authorized_cents
       FROM roles_and_users u LEFT JOIN requests r ON r.user_id = u.id
       WHERE u.permission = 'employee' AND lower(u.name) LIKE ? ESCAPE '\\'
       GROUP BY u.id ORDER BY u.name`,
    )
    .all(pattern) as unknown as PersonSummary[];
}

export type DownloadKind = DocumentKind | "transaction";

export interface FinanceTicket extends RequestView {
  decisions: { kind: string; decision: string; by: string; channel: string; at: string }[];
  // Controlli della riconciliazione (vuoto prima della verifica dei documenti).
  checks: ReconCheck[];
  // Finance può approvare a mano: in coda o in revisione per documenti, mai oltre l'autorizzato.
  canApprove: boolean;
  outcome: ReceiptOutcome | null;
  reimbursed_cents: number | null;
  spent_cents: number | null;
  required: DocumentKind[];
  // Documenti che il dipendente deve ancora caricare (solo se la pratica li attende).
  missing: DocumentKind[];
  downloads: { kind: DownloadKind; original: boolean }[];
}

// Ogni nota spese della persona è un ticket con i download disponibili (scontrino, transazione, fattura).
export function financeTickets(db: DatabaseSync, actorId: unknown, userId: unknown): FinanceTicket[] {
  getActor(db, actorId, "finance");
  const person =
    typeof userId === "string" ? (db.prepare("SELECT id FROM roles_and_users WHERE id = ?").get(userId) as { id: string } | undefined) : undefined;
  if (!person) throw new FlowError(404, "Persona non trovata");
  return toTickets(db, listRequests(db, { userId: person.id }));
}

// Code di Finance, per tutte le persone:
// - review: in revisione perché la riconciliazione ha trovato un'incoerenza (o vecchie pratiche in coda Finance);
// - auto: approvate in automatico dall'agente di verifica;
// - waiting: il dipendente deve ancora caricare scontrino o fattura (con la carta, dopo il pagamento).
export const FINANCE_QUEUES = ["review", "auto", "waiting"] as const;
export type FinanceQueue = (typeof FINANCE_QUEUES)[number];

export function parseFinanceQueue(value: unknown): FinanceQueue | null {
  return FINANCE_QUEUES.includes(value as FinanceQueue) ? (value as FinanceQueue) : null;
}

export function financeQueueOf(t: FinanceTicket): FinanceQueue | null {
  if (t.status === "in_review" || t.status === "pending_finance") return "review";
  if (t.decisions.some((d) => d.kind === "finance" && d.channel === "agent")) return "auto";
  if (t.missing.length > 0 && (t.funding !== "card" || t.downloads.some((d) => d.kind === "transaction"))) return "waiting";
  return null;
}

export function financeQueues(db: DatabaseSync, actorId: unknown): Record<FinanceQueue, FinanceTicket[]> {
  getActor(db, actorId, "finance");
  const queues: Record<FinanceQueue, FinanceTicket[]> = { review: [], auto: [], waiting: [] };
  for (const t of toTickets(db, listRequests(db))) {
    const queue = financeQueueOf(t);
    if (queue) queues[queue].push(t);
  }
  return queues;
}

function toTickets(db: DatabaseSync, rows: RequestView[]): FinanceTicket[] {
  const decisionsOf = db.prepare(
    `SELECT a.kind, a.decision, COALESCE(u.name, '${AGENT_NAME}') AS by, a.channel, a.decided_at AS at FROM approvals a
     LEFT JOIN roles_and_users u ON u.id = a.decided_by WHERE a.request_id = ? ORDER BY a.id`,
  );
  const receiptOf = db.prepare("SELECT outcome, reimbursed_cents, amount_cents, raw_json FROM receipts WHERE request_id = ?");
  return [...rows]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((r) => {
      const v = cardView(db, r.id);
      const receipt = receiptOf.get(r.id) as
        | { outcome: ReceiptOutcome; reimbursed_cents: number | null; amount_cents: number; raw_json: string }
        | undefined;
      const downloads: FinanceTicket["downloads"] = [];
      const doc = (kind: DocumentKind) => v.documents.find((d) => d.kind === kind);
      const receiptDoc = doc("receipt");
      const invoiceDoc = doc("invoice");
      if (receiptDoc) downloads.push({ kind: "receipt", original: hasOriginal(receiptDoc) });
      if (v.transaction) downloads.push({ kind: "transaction", original: false });
      if (invoiceDoc) downloads.push({ kind: "invoice", original: hasOriginal(invoiceDoc) });
      return {
        ...r,
        decisions: decisionsOf.all(r.id) as unknown as FinanceTicket["decisions"],
        outcome: receipt?.outcome ?? null,
        checks: receipt ? checksOf(receipt.raw_json) : [],
        canApprove: canFinanceApprove(r.status, receipt?.outcome ?? null),
        reimbursed_cents: receipt?.reimbursed_cents ?? null,
        spent_cents: v.transaction?.amount_cents ?? receipt?.amount_cents ?? null,
        required: v.required,
        missing: expectsDocuments(r) ? v.missing : [],
        downloads,
      };
    });
}

const DOCUMENTS_ROOT = resolve("data", "documents");

function hasOriginal(d: DocumentRow): boolean {
  return d.source === "upload" && d.path !== null && d.mime !== null;
}

// Percorso dell'originale solo se sta dentro data/documents: il percorso viene dal database, mai dal client.
export function safeDocumentPath(path: string | null, root = DOCUMENTS_ROOT): string | null {
  if (!path) return null;
  const full = resolve(path);
  return full.startsWith(root + sep) ? full : null;
}

export type Download =
  | { type: "file"; path: string; mime: string; filename: string; fallback: TicketData["documents"][number] }
  | { type: "summary"; document: TicketData["documents"][number] }
  | { type: "transaction"; transaction: NonNullable<TicketData["transaction"]>; card: TicketData["card"] };

const EXT: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// Solo Finance. Scontrino e fattura: l'originale caricato oppure, se sintetico, un PDF con i dati estratti.
// Transazione: un PDF costruito dai dati del provider della carta.
export function documentDownload(db: DatabaseSync, actorId: unknown, requestId: unknown, kind: unknown): Download {
  getActor(db, actorId, "finance");
  if (kind !== "receipt" && kind !== "invoice" && kind !== "transaction") throw new FlowError(400, "Tipo di documento non valido");
  const v = cardView(db, requestId);
  if (kind === "transaction") {
    const t = v.transaction;
    if (!t) throw new FlowError(404, "Nessuna transazione per questa pratica");
    return {
      type: "transaction",
      transaction: {
        id: t.id,
        merchantName: t.merchant_name,
        merchantCategory: t.merchant_category,
        merchantCity: t.merchant_city,
        amountCents: t.amount_cents,
        capturedAt: t.captured_at,
      },
      card: v.card?.last4 ? { last4: v.card.last4, limitCents: v.card.limit_cents, allowedCategories: JSON.parse(v.card.allowed_categories) } : null,
    };
  }
  const d = v.documents.find((doc) => doc.kind === kind);
  if (!d) throw new FlowError(404, kind === "invoice" ? "Fattura non caricata" : "Scontrino non caricato");
  const summary: TicketData["documents"][number] = {
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
  };
  const path = hasOriginal(d) ? safeDocumentPath(d.path) : null;
  if (!path) return { type: "summary", document: summary };
  const short = v.request.id.slice(0, 8);
  return { type: "file", path, mime: d.mime!, filename: `${kind === "invoice" ? "fattura" : "scontrino"}-${short}.${EXT[d.mime!] ?? "bin"}`, fallback: summary };
}
