import type { ReactNode } from "react";
import type { DatabaseSync } from "node:sqlite";
import { Chat, ResetButton, type CardData, type CardPanelData, type MessageData, type RequestItem } from "./components";
import { DEMO_TRIP_ID, openDatabase } from "../lib/db";
import { formatEuro } from "../lib/format";
import {
  RECEIPT_OVER_CENTS,
  cardView,
  listEvents,
  listMessages,
  listRequests,
  type Actor,
  type Card,
  type Permission,
  type RequestRow,
  type RequestView,
  type Status,
} from "../lib/flow";
import { loadPolicy, readPolicy } from "../lib/policy";
import { IconChart, IconShield, IconUser, Logo } from "./icons";

const STATUS_LABEL: Record<Status, string> = {
  draft: "Bozza",
  pending_manager: "In attesa del manager",
  approved: "Autorizzata, attende la ricevuta",
  rejected: "Rifiutata",
  in_review: "In revisione (ricevuta oltre l'autorizzato)",
  pending_finance: "In coda Finance",
  finance_approved: "Approvata da Finance",
  exported: "Esportata",
};
const OUTCOME_LABEL: Record<string, string> = {
  match: "documenti coerenti",
  over_authorized: "oltre l'autorizzato",
  capped: "rimborso limitato al residuo",
  mismatch: "non corrisponde alla transazione",
};
const CATEGORY_LABEL: Record<string, string> = { taxi: "Taxi", train: "Treno", meals: "Cibo", hotel: "Hotel", other: "Altro" };
const TITLE: Record<Permission, string> = { employee: "Dipendente", manager: "Manager", finance: "Finance" };
const SCREENS: { permission: Permission; href: string; icon: ReactNode }[] = [
  { permission: "employee", href: "/employee", icon: <IconUser /> },
  { permission: "manager", href: "/manager", icon: <IconShield /> },
  { permission: "finance", href: "/finance", icon: <IconChart /> },
];
const SUBTITLE: Record<Permission, string> = {
  employee: "Chiedi prima di spendere",
  manager: "Decidi solo le eccezioni",
  finance: "Pratiche pronte per la contabilità",
};
const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
const PLACEHOLDER: Record<string, string> = {
  employee: "Scrivi cosa ti serve, per esempio: «Sono davanti alla stazione, il taxi costa 42 €. Rientra nel mio budget?»",
  manager: "Qui arrivano le richieste da approvare. Puoi chiedere «cosa ho in coda?»",
  finance: "Qui arrivano le pratiche verificate. Puoi chiedere «cosa c'è da approvare?»",
};

const KIND_LABEL = { receipt: "Scontrino/ricevuta", invoice: "Fattura intestata all'azienda" } as const;

// Stato della pratica per la UI, derivato dalla carta (cardView).
function statusLabel(db: DatabaseSync, r: RequestRow): string {
  if (r.funding === "card" && r.status === "approved") {
    const v = cardView(db, r.id);
    if (v.transaction) return "Pagata, attende i documenti";
    if (v.card?.status === "pending") return "Autorizzata: carta in generazione";
    if (v.card?.status === "active") return "Autorizzata: carta pronta";
  }
  if (r.funding === "personal" && r.status === "approved") return "Autorizzata: paga con la tua carta, attende lo scontrino";
  if (r.status === "rejected" && r.funding === "personal" && (r.authorized_cents ?? 0) > 0) {
    return `Deroga rifiutata: carta personale fino a ${formatEuro(r.authorized_cents ?? 0)}`;
  }
  return STATUS_LABEL[r.status];
}

function awaitingDocs(db: DatabaseSync, r: RequestRow): boolean {
  const waiting = (r.status === "approved" && r.authorized_cents !== null) || (r.status === "rejected" && r.funding === "personal" && (r.authorized_cents ?? 0) > 0);
  if (!waiting) return false;
  return r.funding !== "card" || cardView(db, r.id).transaction !== null;
}

function buildCard(db: DatabaseSync, requestId: string): CardPanelData {
  const v = cardView(db, requestId);
  const r = v.request;
  const personal = r.funding === "personal" || v.card?.status === "failed";
  const status = v.card?.status;
  const stateLabel = v.transaction ? "usata" : status === "active" ? "attiva" : status === "pending" ? "in generazione" : status === "failed" ? "non generata" : "disattivata";
  const limitCents = v.card?.limit_cents ?? r.authorized_cents ?? 0;
  const docs = v.required.map((kind) => ({ kind, label: KIND_LABEL[kind], present: !v.missing.includes(kind) }));
  const b = v.billing;
  return {
    requestId,
    funding: personal ? "personal" : "card",
    last4: v.card?.last4 ?? null,
    limit: formatEuro(limitCents),
    limitCents,
    category: v.rule.label,
    stateLabel,
    stateReason: status === "failed" ? v.card?.error ?? null : null,
    transaction: v.transaction ? { merchant: v.transaction.merchant_name, amount: formatEuro(v.transaction.amount_cents) } : null,
    docs,
    billing: b ? { name: b.name, vatNumber: b.vatNumber, sdiCode: b.sdiCode, pec: b.pec } : null,
    invoiceNote: v.rule.invoiceNote,
    canPay: !personal && status === "active" && !v.transaction && r.status === "approved",
    canUpload: awaitingDocs(db, r) && v.missing.length > 0,
    popup: !personal && status === "active" && !v.transaction && v.rule.requiresInvoice,
  };
}

function verificationOf(db: DatabaseSync, requestId: string): string | null {
  const row = db.prepare("SELECT outcome FROM receipts WHERE request_id = ?").get(requestId) as { outcome: string } | undefined;
  return row ? (OUTCOME_LABEL[row.outcome] ?? row.outcome) : null;
}

function toItem(db: DatabaseSync, r: RequestView): RequestItem {
  return {
    id: r.id,
    employee: r.employee_name,
    employeeRole: r.employee_role,
    category: CATEGORY_LABEL[r.category],
    amount: formatEuro(r.amount_cents),
    authorized: formatEuro(r.authorized_cents ?? r.amount_cents),
    overAuthorized: formatEuro((r.authorized_cents ?? r.amount_cents) + RECEIPT_OVER_CENTS),
    budget: formatEuro(r.budget_cents),
    extra: formatEuro(r.extra_cents),
    priority: r.priority,
    priorityLabel: r.priority_label,
    status: r.status,
    statusLabel: statusLabel(db, r),
    funding: r.funding === "card" ? "carta virtuale" : r.funding === "personal" ? "carta personale, rimborso" : null,
    verification: verificationOf(db, r.id),
    awaitingDocs: awaitingDocs(db, r),
    card: r.funding ? buildCard(db, r.id) : null,
    clause: r.clause_id,
    quote: r.clause_quote,
    policyGap: r.policy_gap === 1,
    reason: r.reason,
  };
}

const time = (iso: string) => new Date(iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

// Una schermata per ruolo: la stessa chat, con l'utente scelto tra quelli del ruolo.
export async function ChatScreen({ permission, as, aside }: { permission: Permission; as?: string; aside?: ReactNode }) {
  const db = openDatabase();
  let users: Actor[];
  let actor: Actor;
  let messages: MessageData[];
  let pending: CardPanelData[] = [];
  let activeVersion: string;
  try {
    activeVersion = readPolicy(db).version;
    users = db
      .prepare("SELECT id, name, role, permission FROM roles_and_users WHERE permission = ? ORDER BY name")
      .all(permission) as unknown as Actor[];
    actor = users.find((u) => u.id === as) ?? users[0];

    messages = listMessages(db, actor.id).map((m) => {
      const card = m.card ? (JSON.parse(m.card) as Card) : null;
      let data: CardData | null = null;
      if (card?.type === "proposal") {
        const confirmed = m.request_id ? listRequests(db, { ids: [m.request_id] })[0] : null;
        data = {
          type: "proposal",
          messageId: m.id,
          confirmedStatus: confirmed ? statusLabel(db, confirmed) : null,
          category: CATEGORY_LABEL[card.proposal.category],
          amount: formatEuro(card.proposal.amountCents),
          limit: card.proposal.limitCents === null ? null : formatEuro(card.proposal.limitCents),
          budget: formatEuro(card.budgetCents),
          extra: formatEuro(card.extraCents),
          priority: card.priority,
          priorityLabel: card.priorityLabel,
          clause: card.proposal.clauseRef,
          quote: card.proposal.clauseQuote,
          policyGap: card.proposal.policyGap,
        };
      } else if (card?.type === "requests") {
        data = { type: "requests", items: listRequests(db, { ids: card.ids }).map((r) => toItem(db, r)) };
      } else if (card?.type === "card") {
        data = { type: "card", ...buildCard(db, card.requestId) };
      } else if (card?.type === "events") {
        data = {
          type: "events",
          items: listEvents(db, actor).map((e) => ({
            id: e.id,
            time: time(e.created_at),
            type: e.type,
            actor: e.actor_name ?? "sistema",
            request: e.request_id?.slice(0, 8) ?? "",
            details: e.payload === "{}" ? "" : e.payload,
          })),
        };
      } else if (card?.type === "policy") {
        const doc = loadPolicy(db, card.version);
        data = {
          type: "policy",
          version: doc.version,
          filename: doc.filename,
          pages: doc.pages,
          active: doc.version === activeVersion,
          sections: doc.chunks.map((c) => ({ heading: c.heading, page: c.page })),
        };
      } else if (card?.type === "telegram_code") {
        data = card;
      }
      return { id: m.id, role: m.role, content: m.content, time: time(m.created_at), card: data };
    });
    // Percorso con carta personale: il modulo di caricamento resta in cima alla chat finché mancano i documenti.
    if (permission === "employee") {
      pending = listRequests(db, { userId: actor.id })
        .filter((r) => r.funding === "personal" && awaitingDocs(db, r))
        .map((r) => buildCard(db, r.id));
    }
  } finally {
    db.close();
  }

  const chat = <Chat actorId={actor.id} permission={actor.permission} messages={messages} placeholder={PLACEHOLDER[permission]} pending={pending} />;

  return (
    <div className="shell">
      <aside className="sidebar">
        <a href="/" className="brand">
          <Logo size={28} />
          <span className="wordmark">Ask<i>&amp;</i>Card</span>
        </a>
        <nav className="nav-group" aria-label="Ruoli">
          <div className="nav-label">Vista</div>
          {SCREENS.map((s) => (
            <a key={s.href} href={s.href} className={s.permission === permission ? "nav-item active" : "nav-item"}>
              {s.icon}
              {TITLE[s.permission]}
            </a>
          ))}
        </nav>
        {users.length > 1 && (
          <nav className="nav-group" aria-label="Utente">
            <div className="nav-label">Accedi come</div>
            {users.map((u) => (
              <a key={u.id} href={`?as=${u.id}`} className={u.id === actor.id ? "nav-item active" : "nav-item"}>
                <span className="avatar">{initials(u.name)}</span>
                {u.name}
                <span className="meta">{u.role}</span>
              </a>
            ))}
          </nav>
        )}
        <div className="sidebar-foot">
          <dl className="facts">
            <dt>Trasferta</dt>
            <dd>{DEMO_TRIP_ID}</dd>
            <dt>Policy</dt>
            <dd>{activeVersion}</dd>
          </dl>
          <ResetButton />
        </div>
      </aside>
      <main className="content">
        <header className="topbar">
          <div className="who">
            <h1>{actor.name}</h1>
            <span className="sub">
              {TITLE[permission]} · {actor.role} — {SUBTITLE[permission]}
            </span>
          </div>
        </header>
        {aside ? (
          <div className="workspace with-aside">
            <div className="aside">{aside}</div>
            {chat}
          </div>
        ) : (
          <div className="workspace">{chat}</div>
        )}
      </main>
    </div>
  );
}
