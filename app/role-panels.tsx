import type { ReactNode } from "react";
import type { DatabaseSync } from "node:sqlite";
import { ActionButton, CardPanel, PolicyUpload } from "./components";
import { CategoryIcon, IconAlert, IconCheck, IconDownload, IconFile, IconSearch, IconX } from "./icons";
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

function Tabs({ params, name, items }: { params: Params; name: string; items: { value: string; label: string; count?: number }[] }) {
  const current = params[name] ?? items[0].value;
  return (
    <nav className="seg" aria-label="Sezioni">
      {items.map((item, i) => (
        <a
          key={item.value}
          href={href(params, { [name]: i === 0 ? undefined : item.value })}
          className={current === item.value ? "active" : ""}
          aria-current={current === item.value ? "page" : undefined}
        >
          {item.label}
          {item.count !== undefined && <span className="count">{item.count}</span>}
        </a>
      ))}
    </nav>
  );
}

const date = (iso: string) => new Date(iso).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

function missingText(missing: DocumentKind[]): string | null {
  if (missing.length === 2) return "Mancano scontrino e fattura";
  if (missing[0] === "receipt") return "Manca lo scontrino";
  if (missing[0] === "invoice") return "Manca la fattura";
  return null;
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="panel-empty">
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

// Riga titolo di una pratica: icona categoria, titolo, sottotitolo, importo.
function ItemHead({ r, title, sub, right }: { r: RequestView; title: ReactNode; sub: ReactNode; right?: ReactNode }) {
  return (
    <div className="item-head">
      <span className="item-icon">
        <CategoryIcon label={CATEGORY_LABEL[r.category]} size={16} />
      </span>
      <div className="item-title">
        <strong>{title}</strong>
        <span>{sub}</span>
      </div>
      <div className="item-right">
        <span className="item-amount">{formatEuro(r.amount_cents)}</span>
        {right}
      </div>
    </div>
  );
}

// Avanzamento della pratica, solo per mostrare a che punto è.
const STEPS = ["Richiesta", "Autorizzata", "Documenti", "Chiusa"];

function stepOf(r: RequestView, missing: DocumentKind[]): number {
  if (r.status === "draft" || r.status === "pending_manager") return 1;
  if (r.status === "approved" || r.status === "rejected") return missing.length > 0 || r.status === "approved" ? 2 : 3;
  if (r.status === "in_review") return 2;
  if (r.status === "pending_finance") return 3;
  return 4;
}

function Progress({ r, missing }: { r: RequestView; missing: DocumentKind[] }) {
  const step = stepOf(r, missing);
  const blocked = r.status === "in_review";
  return (
    <ol className="steps" aria-label={`Passaggio ${Math.min(step + 1, 4)} di 4`}>
      {STEPS.map((label, i) => (
        <li key={label} className={i < step ? "done" : i === step ? (blocked ? "now blocked" : "now") : ""}>
          <span className="pip" />
          {label}
        </li>
      ))}
    </ol>
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
  const todo = (tab === "open" ? items : employeeRequests(db, actor.id, "open")).filter((r) => r.missing.length > 0).length;
  return (
    <section className="panel">
      <header className="panel-top">
        <h2>Le mie richieste</h2>
        {todo > 0 && (
          <span className="tag p3">
            <IconAlert size={13} /> {todo} da completare
          </span>
        )}
      </header>
      <Tabs
        params={params}
        name="tab"
        items={[
          { value: "open", label: "In corso", count: openCount },
          { value: "done", label: "Completate" },
        ]}
      />
      {items.length === 0 &&
        (tab === "open" ? (
          <Empty title="Nessuna richiesta in corso" text="Scrivi in chat la spesa che devi fare: se rientra è subito autorizzata." />
        ) : (
          <Empty title="Ancora niente di completato" text="Qui trovi le pratiche chiuse da Finance." />
        ))}
      {items.map((r) => {
        const missing = missingText(r.missing);
        return (
          <article className={`item${missing ? " attention" : ""}`} key={r.id}>
            <ItemHead r={r} title={CATEGORY_LABEL[r.category]} sub={date(r.created_at)} />
            {(r.status !== "rejected" || r.missing.length > 0) && <Progress r={r} missing={r.missing} />}
            <div className="item-meta">
              <span className={`tag status status-${r.status}`}>{statusLabel(db, r)}</span>
              {r.authorized_cents !== null && <span className="muted small">Autorizzato {formatEuro(r.authorized_cents)}</span>}
            </div>
            {missing && (
              <div className="callout">
                <IconAlert size={15} /> {missing}
              </div>
            )}
            {r.canUpload && (
              <div className="item-body">
                <CardPanel data={buildCard(db, r.id)} actorId={actor.id} permission="employee" />
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}

// --- Manager ---

const URGENCY_LABEL: Record<Urgency, string> = { immediate: "Immediata", day: "Entro 24 ore", week: "Entro 7 giorni", later: "Più avanti" };

export function ManagerPanel({ params }: { params: Params }) {
  return withActor("manager", params, (db, actor) => managerPanel(db, actor, params));
}

function managerPanel(db: DatabaseSync, actor: Actor, params: Params) {
  const view = params.view === "approved" || params.view === "rejected" ? params.view : "pending";
  const urgency = parseUrgency(params.urgency);
  const queueCount = managerQueue(db, actor.id).length;
  return (
    <section className="panel">
      <header className="panel-top">
        <h2>Deroghe</h2>
        {queueCount > 0 && <span className="tag p4">{queueCount} da decidere</span>}
      </header>
      <Tabs
        params={{ ...params, urgency: undefined }}
        name="view"
        items={[
          { value: "pending", label: "In attesa", count: queueCount },
          { value: "approved", label: "Approvate" },
          { value: "rejected", label: "Rifiutate" },
        ]}
      />
      {view === "pending" ? (
        <>
          <div className="chips" role="group" aria-label="Filtra per urgenza">
            <a href={href(params, { urgency: undefined })} className={urgency ? "" : "active"}>
              Tutte
            </a>
            {(Object.keys(URGENCY_LABEL) as Urgency[]).map((u) => {
              const n = managerQueue(db, actor.id, u).length;
              return (
                <a key={u} href={href(params, { urgency: u })} className={`${urgency === u ? "active" : ""}${n === 0 ? " empty" : ""}`}>
                  {URGENCY_LABEL[u]}
                  {n > 0 && <span className="count">{n}</span>}
                </a>
              );
            })}
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
  if (items.length === 0)
    return (
      <Empty
        title={urgency ? "Niente con questa urgenza" : "Nessuna deroga da decidere"}
        text="Le spese dentro la policy si autorizzano da sole. Qui arrivano solo quelle che sforano."
      />
    );
  return items.map((r) => (
    <article className="item" key={r.id}>
      <div className="item-head">
        <span className="avatar">{initials(r.employee_name)}</span>
        <div className="item-title">
          <strong>{r.employee_name}</strong>
          <span>
            {CATEGORY_LABEL[r.category]} · {URGENCY_LABEL[r.urgency]}
          </span>
        </div>
        <div className="item-right">
          <span className="item-amount">{formatEuro(r.amount_cents)}</span>
          <span className={`tag p${r.priority}`}>{r.priority_label}</span>
        </div>
      </div>
      <dl className="ledger">
        <div>
          <dt>Budget residuo</dt>
          <dd>{formatEuro(r.budget_cents)}</dd>
        </div>
        <div className="key">
          <dt>Deroga richiesta</dt>
          <dd>{formatEuro(r.extra_cents)}</dd>
        </div>
      </dl>
      {r.reason && <p className="reason">«{r.reason}»</p>}
      {r.policy_gap === 1 && (
        <div className="callout">
          <IconAlert size={15} /> Policy non chiara su questo caso.
        </div>
      )}
      {r.clause_quote && (
        <details className="clause-toggle">
          <summary>Clausola della policy</summary>
          <blockquote>{r.clause_quote}</blockquote>
        </details>
      )}
      <div className="item-actions">
        <ActionButton label="Rifiuta" kind="danger" icon={<IconX size={15} />} url={`/api/requests/${r.id}/decision`} body={{ actorId: actor.id, decision: "rejected" }} />
        <ActionButton
          label={`Approva ${formatEuro(r.extra_cents)}`}
          kind="success"
          icon={<IconCheck size={15} />}
          url={`/api/requests/${r.id}/decision`}
          body={{ actorId: actor.id, decision: "approved" }}
        />
      </div>
    </article>
  ));
}

function decidedList(db: DatabaseSync, actor: Actor, decision: "approved" | "rejected") {
  const items = managerDecisions(db, actor.id, decision);
  if (items.length === 0)
    return <Empty title={`Nessuna richiesta ${decision === "approved" ? "approvata" : "rifiutata"}`} text="Le decisioni prese compaiono qui, con chi le ha prese e quando." />;
  return items.map((r) => (
    <article className="item compact" key={r.id}>
      <ItemHead
        r={r}
        title={r.employee_name}
        sub={`${CATEGORY_LABEL[r.category]} · deroga ${formatEuro(r.extra_cents)}`}
      />
      <div className="item-meta">
        <span className={`tag status ${decision === "approved" ? "status-done" : "status-rejected"}`}>
          {decision === "approved" ? "Approvata" : "Rifiutata"} da {r.decided_by}
        </span>
        <span className="muted small">
          {date(r.decided_at)}
          {r.channel !== "web" ? ` · ${r.channel}` : ""}
        </span>
      </div>
      <div className="muted small">Ora: {statusLabel(db, r)}</div>
    </article>
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
      <form className="search" method="get" role="search">
        {params.as && <input type="hidden" name="as" value={params.as} />}
        <IconSearch size={16} />
        <input name="q" defaultValue={q} placeholder="Cerca un dipendente" aria-label="Cerca per nome" />
        {q && (
          <a className="clear" href={href(params, { q: undefined, person: undefined })} aria-label="Cancella ricerca">
            <IconX size={14} />
          </a>
        )}
      </form>
      {people.length === 0 && <Empty title="Nessuno trovato" text={`Nessun dipendente contiene «${q}» nel nome.`} />}
      <div className="people">
        {people.map((p) => (
          <a key={p.id} href={href(params, { person: p.id })} className={p.id === person?.id ? "active" : ""} aria-current={p.id === person?.id ? "true" : undefined}>
            <span className="avatar">{initials(p.name)}</span>
            <span className="who">
              <strong>{p.name}</strong>
              <span>
                {p.role} · {p.requests} {p.requests === 1 ? "nota" : "note"}
              </span>
            </span>
            <span className="sum">{formatEuro(p.authorized_cents)}</span>
          </a>
        ))}
      </div>
      {person ? tickets(db, actor, person.id, person.name) : people.length > 0 && <p className="muted small hint">Scegli una persona per aprire le sue note spese.</p>}
    </>
  );
}

function tickets(db: DatabaseSync, actor: Actor, personId: string, name: string) {
  const list = financeTickets(db, actor.id, personId);
  const q = `actorId=${encodeURIComponent(actor.id)}`;
  return (
    <>
      <h3 className="section-title">Note spese di {name}</h3>
      {list.length === 0 && <Empty title="Nessuna nota spese" text="Questa persona non ha ancora pratiche." />}
      {list.map((t) => (
        <article className="item" key={t.id}>
          <ItemHead
            r={t}
            title={CATEGORY_LABEL[t.category]}
            sub={
              <>
                <span className="mono">#{t.id.slice(0, 8)}</span> · {date(t.created_at)}
              </>
            }
          />
          <div className="item-meta">
            <span className={`tag status status-${t.status}`}>{statusLabel(db, t)}</span>
          </div>
          <dl className="ledger">
            <div>
              <dt>Autorizzato</dt>
              <dd>{t.authorized_cents === null ? "–" : formatEuro(t.authorized_cents)}</dd>
            </div>
            <div>
              <dt>Speso</dt>
              <dd>{t.spent_cents === null ? "–" : formatEuro(t.spent_cents)}</dd>
            </div>
            {t.reimbursed_cents ? (
              <div className="key">
                <dt>Rimborso</dt>
                <dd>{formatEuro(t.reimbursed_cents)}</dd>
              </div>
            ) : null}
            {t.funding && (
              <div>
                <dt>Pagamento</dt>
                <dd>{t.funding === "card" ? "carta virtuale" : "carta personale"}</dd>
              </div>
            )}
            {t.outcome && (
              <div>
                <dt>Verifica</dt>
                <dd className={t.outcome === "match" ? "good" : "warn"}>{OUTCOME_LABEL[t.outcome] ?? t.outcome}</dd>
              </div>
            )}
          </dl>
          {t.decisions.length > 0 && (
            <ul className="trail">
              {t.decisions.map((d, i) => (
                <li key={i} className={d.decision === "approved" ? "ok" : "no"}>
                  <strong>{DECISION_KIND[d.kind] ?? d.kind}:</strong> {d.decision === "approved" ? "approvata" : "rifiutata"} da {d.by}
                  <span className="muted"> · {date(d.at)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="downloads">
            {t.downloads.map((d) => (
              <a key={d.kind} href={`/api/requests/${t.id}/documents/${d.kind}?${q}`} target="_blank" rel="noreferrer" title={d.original ? "Originale" : "Dati estratti (nessun file originale)"}>
                <IconDownload size={14} />
                {DOWNLOAD_LABEL[d.kind]}
                {d.kind !== "transaction" && !d.original ? " (dati)" : ""}
              </a>
            ))}
            {t.outcome && (
              <a href={`/api/requests/${t.id}/ticket?${q}`} target="_blank" rel="noreferrer" className="strong">
                <IconFile size={14} />
                Ticket PDF
              </a>
            )}
            {t.downloads.length === 0 && !t.outcome && <span className="muted small">Nessun documento ancora.</span>}
          </div>
          {t.status === "pending_finance" && (
            <div className="item-actions">
              <ActionButton label="Approva rimborso" kind="success" icon={<IconCheck size={15} />} url={`/api/requests/${t.id}/finance`} body={{ actorId: actor.id }} />
            </div>
          )}
        </article>
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
        <span className="tag status status-done" style={{ marginLeft: "auto" }}>
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
