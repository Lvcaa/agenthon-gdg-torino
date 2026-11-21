import type { ReactNode } from "react";
import type { DatabaseSync } from "node:sqlite";
import { ActionButton, CardPanel, PolicyUpload } from "./components";
import { CATEGORY_LABEL, buildCard, resolveActor, statusLabel } from "./chat-screen";
import { openDatabase } from "../lib/db";
import { formatEuro } from "../lib/format";
import type { Actor, DocumentKind, RequestView } from "../lib/flow";
import { readPolicy } from "../lib/policy";
import type { Urgency } from "../lib/proposal";
import {
  employeeRequests,
  financePeople,
  financeTickets,
  managerDecisions,
  managerQueue,
  parseUrgency,
  type DownloadKind,
  type EmployeeTab,
} from "../lib/views";

// Sezioni a fianco della chat. Leggono il database a ogni aggiornamento della pagina, quindi seguono la chat
// (che rinfresca ogni 3 secondi). I filtri stanno nell'URL.
// Ogni pannello apre e chiude il database: le parti che lo usano sono funzioni chiamate subito, non componenti,
// perché un componente figlio verrebbe renderizzato dopo la chiusura.

export type Params = Record<string, string | undefined>;

function withActor(permission: Actor["permission"], params: Params, render: (db: DatabaseSync, actor: Actor) => ReactNode) {
  const db = openDatabase();
  try {
    return render(db, resolveActor(db, permission, params.as).actor);
  } finally {
    db.close();
  }
}

function href(params: Params, changes: Params): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, ...changes })) if (value) next.set(key, value);
  return `?${next.toString()}`;
}

function Tabs({ params, name, items }: { params: Params; name: string; items: { value: string; label: string }[] }) {
  const current = params[name] ?? items[0].value;
  return (
    <div className="tabs">
      {items.map((item, i) => (
        <a key={item.value} href={href(params, { [name]: i === 0 ? undefined : item.value })} className={current === item.value ? "active" : ""}>
          {item.label}
        </a>
      ))}
    </div>
  );
}

const date = (iso: string) => new Date(iso).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function missingText(missing: DocumentKind[]): string | null {
  if (missing.length === 2) return "Mancano scontrino e fattura";
  if (missing[0] === "receipt") return "Manca lo scontrino";
  if (missing[0] === "invoice") return "Manca la fattura";
  return null;
}

function Summary({ r }: { r: RequestView }) {
  return (
    <strong>
      {CATEGORY_LABEL[r.category]} · {formatEuro(r.amount_cents)}
    </strong>
  );
}

// --- Dipendente ---

export function EmployeePanel({ params }: { params: Params }) {
  return withActor("employee", params, (db, actor) => employeePanel(db, actor, params));
}

function employeePanel(db: DatabaseSync, actor: Actor, params: Params) {
  const tab: EmployeeTab = params.tab === "done" ? "done" : "open";
  const items = employeeRequests(db, actor.id, tab);
  const openCount = tab === "open" ? items.length : employeeRequests(db, actor.id, "open").length;
  return (
    <section className="panel">
      <h2>Le mie richieste</h2>
      <Tabs
        params={params}
        name="tab"
        items={[
          { value: "open", label: `In corso (${openCount})` },
          { value: "done", label: "Completate" },
        ]}
      />
      {items.length === 0 && <p className="muted small">{tab === "open" ? "Nessuna richiesta in corso." : "Nessuna richiesta completata."}</p>}
      {items.map((r) => {
        const missing = missingText(r.missing);
        return (
          <div className="card" key={r.id}>
            <Summary r={r} /> <span className="muted small">{date(r.created_at)}</span>
            {missing && <div className="tag warn">{missing}</div>}
            <div className="small">{statusLabel(db, r)}</div>
            {r.authorized_cents !== null && <div className="muted small">Autorizzato {formatEuro(r.authorized_cents)}</div>}
            {r.canUpload && <CardPanel data={buildCard(db, r.id)} actorId={actor.id} permission="employee" />}
          </div>
        );
      })}
    </section>
  );
}

// --- Manager ---

const URGENCY_LABEL: Record<Urgency, string> = { immediate: "Immediata", day: "Entro 24 ore", week: "Entro 7 giorni", later: "Più avanti" };

function RequestHead({ r }: { r: RequestView }) {
  return (
    <>
      <strong>
        {r.employee_name} · {CATEGORY_LABEL[r.category]} · {formatEuro(r.amount_cents)}
      </strong>{" "}
      <span className={`tag p${r.priority}`}>{r.priority_label}</span>
      <div className="muted small">
        residuo {formatEuro(r.budget_cents)} · extra <strong>{formatEuro(r.extra_cents)}</strong> · {URGENCY_LABEL[r.urgency]}
      </div>
    </>
  );
}

export function ManagerPanel({ params }: { params: Params }) {
  return withActor("manager", params, (db, actor) => managerPanel(db, actor, params));
}

function managerPanel(db: DatabaseSync, actor: Actor, params: Params) {
  const view = params.view === "approved" || params.view === "rejected" ? params.view : "pending";
  const urgency = parseUrgency(params.urgency);
  const queueCount = managerQueue(db, actor.id).length;
  return (
    <section className="panel">
      <h2>Richieste</h2>
      <Tabs
        params={{ ...params, urgency: undefined }}
        name="view"
        items={[
          { value: "pending", label: `In attesa (${queueCount})` },
          { value: "approved", label: "Approvate" },
          { value: "rejected", label: "Rifiutate" },
        ]}
      />
      {view === "pending" ? (
        <>
          <div className="tabs small">
            <a href={href(params, { urgency: undefined })} className={urgency ? "" : "active"}>
              Tutte
            </a>
            {(Object.keys(URGENCY_LABEL) as Urgency[]).map((u) => (
              <a key={u} href={href(params, { urgency: u })} className={urgency === u ? "active" : ""}>
                {URGENCY_LABEL[u]}
              </a>
            ))}
          </div>
          {pendingList(db, actor, urgency)}
        </>
      ) : (
        decidedList(db, actor, view)
      )}
    </section>
  );
}

function pendingList(db: DatabaseSync, actor: Actor, urgency: Urgency | null) {
  const items = managerQueue(db, actor.id, urgency);
  if (items.length === 0) return <p className="muted small">Nessuna richiesta in attesa{urgency ? " con questa urgenza" : ""}.</p>;
  return items.map((r) => (
    <div className="card" key={r.id}>
      <RequestHead r={r} />
      {r.clause_quote && <blockquote>{r.clause_quote}</blockquote>}
      {r.policy_gap === 1 && <div className="notice">Policy non chiara su questo caso.</div>}
      <div className="small">{r.reason}</div>
      <ActionButton label="Approva" url={`/api/requests/${r.id}/decision`} body={{ actorId: actor.id, decision: "approved" }} />
      <ActionButton label="Rifiuta" kind="danger" url={`/api/requests/${r.id}/decision`} body={{ actorId: actor.id, decision: "rejected" }} />
    </div>
  ));
}

function decidedList(db: DatabaseSync, actor: Actor, decision: "approved" | "rejected") {
  const items = managerDecisions(db, actor.id, decision);
  if (items.length === 0) return <p className="muted small">Nessuna richiesta {decision === "approved" ? "approvata" : "rifiutata"}.</p>;
  return items.map((r) => (
    <div className="card" key={r.id}>
      <RequestHead r={r} />
      <div className="small">
        {decision === "approved" ? "Approvata" : "Rifiutata"} da {r.decided_by} · {date(r.decided_at)}
        {r.channel !== "web" ? ` · ${r.channel}` : ""}
      </div>
      <div className="muted small">Ora: {statusLabel(db, r)}</div>
    </div>
  ));
}

// --- Finance ---

const DOWNLOAD_LABEL: Record<DownloadKind, string> = { receipt: "Scontrino", transaction: "Transazione", invoice: "Fattura" };
const OUTCOME_LABEL: Record<string, string> = {
  match: "documenti coerenti",
  over_authorized: "oltre l'autorizzato",
  capped: "rimborso limitato al residuo",
  mismatch: "non corrisponde alla transazione",
};
const DECISION_KIND: Record<string, string> = { manager: "Manager", manager_supplement: "Manager (integrativa)", finance: "Finance" };

export function FinancePanel({ params }: { params: Params }) {
  return withActor("finance", params, (db, actor) => financePanel(db, actor, params));
}

function financePanel(db: DatabaseSync, actor: Actor, params: Params) {
  return (
    <section className="panel">
      <Tabs
        params={params}
        name="panel"
        items={[
          { value: "expenses", label: "Note spese" },
          { value: "policy", label: "Policy" },
        ]}
      />
      {params.panel === "policy" ? policyPanel(db, actor) : expensesPanel(db, actor, params)}
    </section>
  );
}

function expensesPanel(db: DatabaseSync, actor: Actor, params: Params) {
  const q = params.q ?? "";
  const people = financePeople(db, actor.id, q);
  const person = params.person ? people.find((p) => p.id === params.person) ?? financePeople(db, actor.id).find((p) => p.id === params.person) : undefined;
  return (
    <>
      <form className="search" method="get">
        {params.as && <input type="hidden" name="as" value={params.as} />}
        <input name="q" defaultValue={q} placeholder="Cerca per nome" aria-label="Cerca per nome" />
        <button type="submit">Cerca</button>
      </form>
      {people.length === 0 && <p className="muted small">Nessuna persona trovata.</p>}
      <div className="people">
        {people.map((p) => (
          <a key={p.id} href={href(params, { person: p.id })} className={p.id === person?.id ? "active" : ""}>
            {p.name} <span className="muted small">· {p.requests} {p.requests === 1 ? "nota" : "note"} · {formatEuro(p.authorized_cents)}</span>
          </a>
        ))}
      </div>
      {person && tickets(db, actor, person.id, person.name)}
    </>
  );
}

function tickets(db: DatabaseSync, actor: Actor, personId: string, name: string) {
  const list = financeTickets(db, actor.id, personId);
  const q = `actorId=${encodeURIComponent(actor.id)}`;
  return (
    <>
      <h3>Note spese di {name}</h3>
      {list.length === 0 && <p className="muted small">Nessuna nota spese.</p>}
      {list.map((t) => (
        <div className="card" key={t.id}>
          <Summary r={t} /> <span className="muted small">#{t.id.slice(0, 8)} · {date(t.created_at)}</span>
          <div className="small">{statusLabel(db, t)}</div>
          <div className="muted small">
            Autorizzato {t.authorized_cents === null ? "-" : formatEuro(t.authorized_cents)} · speso {t.spent_cents === null ? "-" : formatEuro(t.spent_cents)}
            {t.reimbursed_cents ? ` · rimborso ${formatEuro(t.reimbursed_cents)}` : ""}
            {t.funding ? ` · ${t.funding === "card" ? "carta virtuale" : "carta personale"}` : ""}
          </div>
          {t.outcome && <div className="muted small">Verifica: {OUTCOME_LABEL[t.outcome] ?? t.outcome}</div>}
          {t.decisions.map((d, i) => (
            <div key={i} className="muted small">
              {DECISION_KIND[d.kind] ?? d.kind}: {d.decision === "approved" ? "approvata" : "rifiutata"} da {d.by} · {date(d.at)}
            </div>
          ))}
          <div className="downloads">
            {t.downloads.map((d) => (
              <a key={d.kind} href={`/api/requests/${t.id}/documents/${d.kind}?${q}`} target="_blank" rel="noreferrer" title={d.original ? "Originale" : "Dati estratti (nessun file originale)"}>
                {DOWNLOAD_LABEL[d.kind]}
                {d.kind !== "transaction" && !d.original ? " (dati)" : ""}
              </a>
            ))}
            {t.outcome && (
              <a href={`/api/requests/${t.id}/ticket?${q}`} target="_blank" rel="noreferrer">
                Ticket PDF
              </a>
            )}
            {t.downloads.length === 0 && !t.outcome && <span className="muted small">Nessun documento ancora.</span>}
          </div>
          {t.status === "pending_finance" && <ActionButton label="Approva rimborso" url={`/api/requests/${t.id}/finance`} body={{ actorId: actor.id }} />}
        </div>
      ))}
    </>
  );
}

function policyPanel(db: DatabaseSync, actor: Actor) {
  const policy = readPolicy(db);
  return (
    <>
      <div className="panel-head">
        <h2>Policy aziendale</h2>
        <p className="muted small">È il testo che l&apos;assistente cita in ogni risposta.</p>
      </div>
      <PolicyUpload actorId={actor.id} />
      <div className="policy-info">
        <div>
          <strong>{policy.filename}</strong>
          <div className="muted small">
            versione {policy.version} · {policy.pages} {policy.pages === 1 ? "pagina" : "pagine"} · {policy.chunks.length} sezioni
          </div>
        </div>
        <span className="tag status-done" style={{ marginLeft: "auto" }}>
          Attiva
        </span>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Controlla che le sezioni qui sotto siano quelle del documento: l&apos;assistente legge solo i pezzi pertinenti a ogni domanda.
      </p>
      <ol className="sections">
        {policy.chunks.map((c) => (
          <li key={c.idx}>
            {c.heading} <span className="muted">p. {c.page}</span>
          </li>
        ))}
      </ol>
    </>
  );
}
