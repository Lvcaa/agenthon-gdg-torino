import type { ReactNode } from "react";
import { Chat, ResetButton, type CardData, type MessageData, type RequestItem } from "./components";
import { DEMO_TRIP_ID, openDatabase } from "../lib/db";
import { formatEuro } from "../lib/format";
import {
  RECEIPT_OVER_CENTS,
  listEvents,
  listMessages,
  listRequests,
  type Actor,
  type Card,
  type Permission,
  type RequestView,
  type Status,
} from "../lib/flow";
import { loadPolicy, readPolicy } from "../lib/policy";

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
const CATEGORY_LABEL: Record<string, string> = { taxi: "Taxi", train: "Treno", meals: "Cibo", hotel: "Hotel", other: "Altro" };
const TITLE: Record<Permission, string> = { employee: "Dipendente", manager: "Manager", finance: "Finance" };
const SCREENS: { permission: Permission; href: string }[] = [
  { permission: "employee", href: "/employee" },
  { permission: "manager", href: "/manager" },
  { permission: "finance", href: "/finance" },
];
const PLACEHOLDER: Record<string, string> = {
  employee: "Scrivi cosa ti serve, per esempio: «Sono davanti alla stazione, il taxi costa 42 €. Rientra nel mio budget?»",
  manager: "Qui arrivano le richieste da approvare. Puoi chiedere «cosa ho in coda?»",
  finance: "Qui arrivano le pratiche verificate. Puoi chiedere «cosa c'è da approvare?»",
};

function toItem(r: RequestView): RequestItem {
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
    statusLabel: STATUS_LABEL[r.status],
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
          confirmedStatus: confirmed ? STATUS_LABEL[confirmed.status] : null,
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
        data = { type: "requests", items: listRequests(db, { ids: card.ids }).map(toItem) };
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
  } finally {
    db.close();
  }

  return (
    <main className={aside ? "wide" : "narrow"}>
      <header>
        <div>
          <h1>{TITLE[permission]}</h1>
          <div className="muted">
            {actor.name} · {actor.role} · trasferta {DEMO_TRIP_ID} · policy {activeVersion}
          </div>
        </div>
        <ResetButton />
      </header>
      <nav>
        {SCREENS.map((s) => (
          <a key={s.href} href={s.href} className={s.permission === permission ? "active" : ""}>
            {TITLE[s.permission]}
          </a>
        ))}
        {users.length > 1 &&
          users.map((u) => (
            <a key={u.id} href={`?as=${u.id}`} className={u.id === actor.id ? "active user" : "user"}>
              {u.name} · {u.role}
            </a>
          ))}
      </nav>
      {aside ? (
        <div className="columns">
          <div>{aside}</div>
          <Chat actorId={actor.id} permission={actor.permission} messages={messages} placeholder={PLACEHOLDER[permission]} />
        </div>
      ) : (
        <Chat actorId={actor.id} permission={actor.permission} messages={messages} placeholder={PLACEHOLDER[permission]} />
      )}
    </main>
  );
}
