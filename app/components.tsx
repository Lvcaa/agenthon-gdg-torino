"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CategoryIcon, IconAlert, IconCheck, IconDownload, IconFile, IconReceipt, IconReset, IconTelegram, IconUpload } from "./icons";

type Json = Record<string, unknown>;

async function post(url: string, body: Json): Promise<{ ok: boolean; data: Json }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Json;
  return { ok: res.ok, data };
}

export interface RequestItem {
  id: string;
  employee: string;
  employeeRole: string;
  category: string;
  amount: string;
  authorized: string;
  overAuthorized: string;
  budget: string;
  extra: string;
  priority: number;
  priorityLabel: string;
  status: string;
  statusLabel: string;
  clause: string;
  quote: string | null;
  policyGap: boolean;
  reason: string;
  funding: string | null;
  verification: string | null;
  financeApprovable: boolean;
  awaitingDocs: boolean;
  card: CardPanelData | null;
}

export interface CardPanelData {
  requestId: string;
  funding: "card" | "personal";
  last4: string | null;
  limit: string;
  limitCents: number;
  category: string;
  stateLabel: string;
  stateReason: string | null;
  transaction: { merchant: string; amount: string } | null;
  docs: { kind: "receipt" | "invoice"; label: string; present: boolean }[];
  billing: { name: string; vatNumber: string; sdiCode: string; pec: string } | null;
  invoiceNote: string;
  canPay: boolean;
  canUpload: boolean;
  popup: boolean;
}

export interface EventItem {
  id: number;
  time: string;
  type: string;
  actor: string;
  request: string;
  details: string;
}

export type CardData =
  | {
      type: "proposal";
      messageId: number;
      confirmedStatus: string | null;
      category: string;
      amount: string;
      limit: string | null;
      budget: string;
      extra: string;
      priority: number;
      priorityLabel: string;
      clause: string;
      quote: string | null;
      policyGap: boolean;
    }
  | ({ type: "card" } & CardPanelData)
  | { type: "requests"; items: RequestItem[] }
  | { type: "events"; items: EventItem[] }
  | { type: "telegram_code"; code: string; expiresAt: string }
  | { type: "policy"; version: string; filename: string; pages: number; active: boolean; sections: { heading: string; page: number }[] };

export interface MessageData {
  id: number;
  role: "user" | "assistant";
  content: string;
  time: string;
  card: CardData | null;
}

export function ActionButton(props: { label: string; url: string; body: Json; kind?: "danger" | "primary" | "success"; icon?: ReactNode }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setMessage("");
    const { ok, data } = await post(props.url, props.body);
    setBusy(false);
    if (!ok) setMessage(String(data.error ?? "Errore"));
    router.refresh();
  }

  return (
    <span className="action">
      <button className={props.kind} disabled={busy} onClick={run}>
        {props.icon}
        {props.label}
      </button>
      {message && <span className="error">{message}</span>}
    </span>
  );
}

function CsvButton({ requestId, actorId }: { requestId: string; actorId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState("");

  async function download() {
    setMessage("");
    const res = await fetch(`/api/requests/${requestId}/csv?actorId=${encodeURIComponent(actorId)}`);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as Json;
      setMessage(String(data.error ?? "Errore"));
    } else {
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `rimborso-${requestId}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    }
    router.refresh();
  }

  return (
    <span className="action">
      <button onClick={download}>
        <IconDownload size={15} />
        Scarica CSV
      </button>
      {message && <span className="error">{message}</span>}
    </span>
  );
}

function InvoicePopup({ requestId, billing, note }: { requestId: string; billing: NonNullable<CardPanelData["billing"]>; note: string }) {
  const key = `invoice-popup-${requestId}`;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(key)) setOpen(true);
    } catch {
      setOpen(true);
    }
  }, [key]);

  function close() {
    try {
      localStorage.setItem(key, "1");
    } catch {}
    setOpen(false);
  }

  if (!open) return null;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby={`${key}-title`}>
      <div className="modal">
        <h2 id={`${key}-title`}>Ricordati la fattura</h2>
        <p>
          Per questa spesa chiedi la fattura intestata all&apos;azienda{note ? `. ${note}` : "."}
        </p>
        <dl className="billing">
          <dt>Ragione sociale</dt>
          <dd>{billing.name}</dd>
          <dt>P.IVA</dt>
          <dd>{billing.vatNumber}</dd>
          <dt>Codice SDI</dt>
          <dd>{billing.sdiCode}</dd>
          <dt>PEC</dt>
          <dd>{billing.pec}</dd>
        </dl>
        <p className="muted small">Se non carichi ricevuta, scontrino e fattura, la funzione carta potrebbe esserti disabilitata in futuro.</p>
        <button className="primary" onClick={close}>
          Ho capito
        </button>
      </div>
    </div>
  );
}

function PayForm({ data, actorId }: { data: CardPanelData; actorId: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState((data.limitCents / 100).toFixed(2).replace(".", ","));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function pay() {
    const cents = Math.round(Number(amount.replace(",", ".")) * 100);
    if (!Number.isInteger(cents) || cents <= 0) {
      setMessage("Importo non valido");
      return;
    }
    setBusy(true);
    setMessage("");
    const { ok, data: res } = await post(`/api/requests/${data.requestId}/pay`, { actorId, amountCents: cents });
    setBusy(false);
    if (!ok) setMessage(String(res.error ?? "Errore"));
    else if (res.approved === false) setMessage(`Pagamento rifiutato: ${String(res.reason ?? "")}`);
    router.refresh();
  }

  return (
    <div className="pay-row">
      <label className="money">
        <span>€</span>
        <input className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} aria-label="Importo" />
      </label>
      <button className="primary" disabled={busy} onClick={pay}>
        Paga con la carta (sandbox)
      </button>
      {message && <span className="error">{message}</span>}
    </div>
  );
}

function UploadForm({ requestId, kind, label, actorId }: { requestId: string; kind: "receipt" | "invoice"; label: string; actorId: string }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function upload() {
    if (!file) {
      setMessage("Scegli un file");
      return;
    }
    setBusy(true);
    setMessage("");
    const form = new FormData();
    form.set("actorId", actorId);
    form.set("kind", kind);
    form.set("file", file);
    const res = await fetch(`/api/requests/${requestId}/documents`, { method: "POST", body: form });
    const data = (await res.json().catch(() => ({}))) as Json;
    setBusy(false);
    if (!res.ok) setMessage(String(data.error ?? "Errore"));
    else setFile(null);
    router.refresh();
  }

  return (
    <div className="upload-row">
      <label className="file-pick">
        <IconUpload size={15} />
        <span>{file ? file.name : `Scegli ${label.toLowerCase()}`}</span>
        <input type="file" accept="image/*,application/pdf" hidden disabled={busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <button className="primary" disabled={busy || !file} onClick={upload}>
        {busy ? "Lettura in corso…" : "Carica"}
      </button>
      {message && <div className="error">{message}</div>}
    </div>
  );
}

// Carta della pratica: virtuale (monouso) oppure personale con rimborso. Mostra documenti, pagamento e caricamento.
export function CardPanel({ data, actorId, permission }: { data: CardPanelData; actorId: string; permission: string }) {
  const employee = permission === "employee";
  const personal = data.funding === "personal";
  return (
    <div className="doc">
      <div className="doc-head">
        {personal ? (
          <div className="title">
            <strong>Carta personale · {data.category}</strong>
            <span>
              Paga con la tua carta fino a {data.limit} e carica lo scontrino: rimborso a fine mese.
              {data.stateReason ? ` ${data.stateReason}` : ""}
            </span>
          </div>
        ) : (
          <>
            <div className="mini-card" aria-hidden="true">
              <span>•••• {data.last4 ?? "----"}</span>
            </div>
            <div className="title">
              <strong>
                Carta virtuale · {data.category} <span className="tag">monouso</span>
              </strong>
              <span>
                Tetto {data.limit} · {data.stateLabel}
                {data.stateReason ? `: ${data.stateReason}` : ""}
              </span>
            </div>
          </>
        )}
      </div>
      {data.transaction && (
        <dl className="ledger">
          <div className="key">
            <dt>Pagato a {data.transaction.merchant}</dt>
            <dd>{data.transaction.amount}</dd>
          </div>
        </dl>
      )}
      <ul className="checklist">
        {data.docs.map((d) => (
          <li key={d.kind} className={d.present ? "done" : undefined}>
            {d.present ? <IconCheck size={14} /> : <span className="dot" />} {d.label}
          </li>
        ))}
      </ul>
      {!data.billing && !personal && data.canPay && <div className="notice">Conserva lo scontrino o la ricevuta: dovrai caricarlo.</div>}
      {data.billing && (
        <div className="notice">
          <span>
            Fattura intestata a {data.billing.name} · P.IVA {data.billing.vatNumber} · SDI {data.billing.sdiCode} · PEC {data.billing.pec}
            {data.invoiceNote && <span className="block">{data.invoiceNote}</span>}
          </span>
        </div>
      )}
      {employee && (data.canPay || data.canUpload) && (
        <div className="doc-foot stack">
          {data.canPay && <PayForm data={data} actorId={actorId} />}
          {data.canUpload &&
            data.docs
              .filter((d) => !d.present)
              .map((d) => <UploadForm key={d.kind} requestId={data.requestId} kind={d.kind} label={d.label} actorId={actorId} />)}
        </div>
      )}
      {employee && data.popup && data.billing && <InvoicePopup requestId={data.requestId} billing={data.billing} note={data.invoiceNote} />}
    </div>
  );
}

function Clause({ clause, text }: { clause: string; text: string | null }) {
  return (
    <div className="clause">
      <div className="clause-ref">Policy · {clause}</div>
      {text && <blockquote>{text}</blockquote>}
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

// Righe contabili: etichetta a sinistra, cifra allineata a destra. "key" evidenzia la cifra che conta.
function Ledger({ rows }: { rows: { label: string; value: string; key?: boolean }[] }) {
  return (
    <dl className="ledger">
      {rows.map((r) => (
        <div key={r.label} className={r.key ? "key" : undefined}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Card({ card, actorId, permission }: { card: CardData; actorId: string; permission: string }) {
  if (card.type === "proposal") {
    return (
      <div className="doc">
        <div className="doc-head">
          <div className="title">
            <strong>
              <CategoryIcon label={card.category} size={16} />
              {card.category}
            </strong>
            <span>Proposta da confermare</span>
          </div>
          <div className="right">
            <span className={`tag p${card.priority}`}>{card.priorityLabel}</span>
            <span className="amount">{card.amount}</span>
          </div>
        </div>
        <Ledger
          rows={[
            { label: "Limite policy", value: card.limit ?? "non definito" },
            { label: "Budget residuo", value: card.budget },
            { label: "Deroga richiesta", value: card.extra, key: true },
          ]}
        />
        <Clause clause={card.clause} text={card.quote} />
        {card.policyGap && (
          <div className="notice">
            <IconAlert size={15} /> La policy non copre questo caso: decide il manager.
          </div>
        )}
        <div className="doc-foot">
          {card.confirmedStatus ? (
            <span className="ok">
              <IconCheck size={15} /> Inviata · {card.confirmedStatus}
            </span>
          ) : (
            <>
              <span className="muted small">Parte solo quando confermi.</span>
              <ActionButton label="Conferma" kind="primary" url="/api/chat/confirm" body={{ actorId, messageId: card.messageId }} />
            </>
          )}
        </div>
      </div>
    );
  }

  if (card.type === "card") {
    return <CardPanel data={card} actorId={actorId} permission={permission} />;
  }

  if (card.type === "requests") {
    return (
      <div className="cards">
        {card.items.map((r) => (
          <div className="doc" key={r.id}>
            <div className="doc-head">
              <span className="avatar">{initials(r.employee)}</span>
              <div className="title">
                <strong>{r.employee}</strong>
                <span>
                  {r.category} · {r.employeeRole}
                </span>
              </div>
              <div className="right">
                <span className={`tag p${r.priority}`}>{r.priorityLabel}</span>
                <span className="amount">{r.amount}</span>
              </div>
            </div>
            <Ledger
              rows={[
                { label: "Budget residuo", value: r.budget },
                { label: "Deroga", value: r.extra, key: true },
                { label: "Autorizzato", value: r.authorized },
                ...(r.funding ? [{ label: "Pagamento", value: r.funding }] : []),
                ...(r.verification ? [{ label: "Verifica documenti", value: r.verification }] : []),
              ]}
            />
            <Clause clause={r.clause} text={r.quote} />
            {r.policyGap && (
              <div className="notice">
                <IconAlert size={15} /> La policy non copre questo caso.
              </div>
            )}
            {permission === "employee" && r.card && r.awaitingDocs && (
              <div className="nested">
                <CardPanel data={r.card} actorId={actorId} permission={permission} />
              </div>
            )}
            <div className="doc-foot">
              <span className={`tag status status-${r.status}`}>{r.statusLabel}</span>
              <div className="actions">
                {permission === "manager" && r.status === "pending_manager" && (
                  <>
                    <ActionButton label="Rifiuta" kind="danger" url={`/api/requests/${r.id}/decision`} body={{ actorId, decision: "rejected" }} />
                    <ActionButton label={`Approva ${r.extra}`} kind="success" icon={<IconCheck size={15} />} url={`/api/requests/${r.id}/decision`} body={{ actorId, decision: "approved" }} />
                  </>
                )}
                {permission === "employee" && r.awaitingDocs && (
                  <>
                    <ActionButton label={`Ricevuta ${r.overAuthorized}`} icon={<IconReceipt size={15} />} url={`/api/requests/${r.id}/receipt`} body={{ actorId, kind: "over" }} />
                    <ActionButton label={`Ricevuta ${r.authorized}`} kind="primary" icon={<IconReceipt size={15} />} url={`/api/requests/${r.id}/receipt`} body={{ actorId, kind: "exact" }} />
                  </>
                )}
                {permission === "finance" && ["pending_finance", "finance_approved", "exported"].includes(r.status) && (
                  <CsvButton requestId={r.id} actorId={actorId} />
                )}
                {permission === "finance" && r.verification && (
                  <a className="btn-link" href={`/api/requests/${r.id}/ticket?actorId=${encodeURIComponent(actorId)}`} target="_blank" rel="noreferrer">
                    <IconFile size={15} /> Ticket PDF
                  </a>
                )}
                {permission === "finance" && r.financeApprovable && (
                  <ActionButton label={r.status === "in_review" ? "Approva dopo revisione" : "Approva rimborso"} kind="success" icon={<IconCheck size={15} />} url={`/api/requests/${r.id}/finance`} body={{ actorId }} />
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (card.type === "events") {
    return (
      <div className="doc">
        <div className="doc-head">
          <div className="title">
            <strong>Registro decisioni</strong>
            <span>Ogni passaggio, chi l&apos;ha fatto e quando. Non modificabile.</span>
          </div>
        </div>
        {card.items.length === 0 ? (
          <div className="clause muted">Nessun evento.</div>
        ) : (
          <table className="log">
            <thead>
              <tr>
                <th>Ora</th>
                <th>Evento</th>
                <th>Chi</th>
              </tr>
            </thead>
            <tbody>
              {card.items.map((e) => (
                <tr key={e.id}>
                  <td>{e.time}</td>
                  <td>
                    <span className="ev">{e.type}</span>
                    {e.request && <span className="muted mono"> #{e.request}</span>}
                    {e.details && <div className="details">{e.details}</div>}
                  </td>
                  <td>{e.actor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  if (card.type === "policy") {
    return (
      <div className="doc">
        <div className="doc-head">
          <div className="title">
            <strong>
              <IconFile size={16} />
              {card.filename}
            </strong>
            <span>
              versione <span className="mono">{card.version}</span> · {card.pages} pagine
            </span>
          </div>
          <div className="right">
            <span className={`tag status ${card.active ? "status-done" : ""}`}>{card.active ? "Attiva" : "Non più attiva"}</span>
          </div>
        </div>
        <ol className="sections">
          {card.sections.map((s, i) => (
            <li key={i}>
              {s.heading} <span className="muted">p. {s.page}</span>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <div className="doc">
      <div className="doc-head">
        <div className="title">
          <strong>
            <IconTelegram size={16} />
            Collega Telegram
          </strong>
          <span>Manda questo codice al bot. Scade alle {new Date(card.expiresAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}.</span>
        </div>
      </div>
      <div className="code" aria-label={card.code}>
        {card.code.split("").map((c, i) => (
          <span key={i}>{c}</span>
        ))}
      </div>
    </div>
  );
}

const SUGGESTIONS: Record<string, string[]> = {
  employee: ["L'hotel per la fiera costa 130 €. Rientra nel mio budget?", "Quanto posso spendere per la cena stasera?", "Mostrami le mie richieste"],
  manager: ["Cosa ho in coda?", "Mostrami il registro delle decisioni", "Collega Telegram"],
  finance: ["Cosa c'è da approvare?", "Mostrami la policy attiva", "Mostrami il registro delle decisioni"],
};

const COMPOSER: Record<string, string> = {
  employee: "Es. hotel per la fiera, 130 €",
  manager: "Es. cosa ho in coda?",
  finance: "Es. cosa c'è da approvare?",
};

const INTRO: Record<string, { title: string; text: string }> = {
  employee: {
    title: "Cosa devi pagare?",
    text: "Scrivi la spesa e quanto costa, anche al volo. Ti rispondo con il tuo limite e la clausola della policy, e se sfori preparo io la richiesta per il manager.",
  },
  manager: {
    title: "Per ora non c'è niente da decidere.",
    text: "Qui compaiono solo le spese fuori policy, con importo, motivo e clausola. Quelle dentro il limite le autorizzo io.",
  },
  finance: {
    title: "Nessuna pratica in coda.",
    text: "Quando una ricevuta torna con l'importo autorizzato, la pratica arriva qui. La approvi e scarichi il CSV per il gestionale.",
  },
};

export function Chat(props: { actorId: string; permission: string; messages: MessageData[]; placeholder: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  // Le notifiche degli altri utenti arrivano come messaggi: la chat si aggiorna da sola.
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [router]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [props.messages.length, pending]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const message = text.trim();
    if (!message || pending) return;
    setPending(true);
    setError("");
    setText("");
    const { ok, data } = await post("/api/chat", { actorId: props.actorId, message });
    setPending(false);
    if (!ok) setError(String(data.error ?? "Errore"));
    router.refresh();
  }

  return (
    <div className="chat">
      <div className="messages" aria-live="polite">
        {props.messages.length === 0 && (
          <div className="empty">
            <h2>{INTRO[props.permission]?.title}</h2>
            <p>{INTRO[props.permission]?.text}</p>
            <div className="suggestions">
              {(SUGGESTIONS[props.permission] ?? []).map((q) => (
                <button key={q} type="button" onClick={() => setText(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {props.messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="msg-body">
              {m.role === "assistant" && (
                <div className="who-line">
                  Assistente <span className="time">{m.time}</span>
                </div>
              )}
              <div className="bubble">
                <div className="text">{m.content}</div>
              </div>
              {m.card && <Card card={m.card} actorId={props.actorId} permission={props.permission} />}
              {m.role === "user" && <div className="time">{m.time}</div>}
            </div>
          </div>
        ))}
        {pending && (
          <div className="msg assistant">
            <div className="typing">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              Leggo la policy…
            </div>
          </div>
        )}
        <div ref={bottom} />
      </div>
      {error && <div className="error">{error}</div>}
      <div className="composer-wrap">
        <form onSubmit={send} className="composer">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={COMPOSER[props.permission] ?? "Scrivi un messaggio…"} maxLength={1000} autoFocus aria-label="Messaggio" />
          <button type="submit" className="primary" disabled={pending || !text.trim()}>
            Invia
          </button>
        </form>
      </div>
    </div>
  );
}

export function ResetButton(): ReactNode {
  const router = useRouter();
  return (
    <button
      className="ghost"
      onClick={async () => {
        await post("/api/demo/reset", {});
        router.refresh();
      }}
    >
      <IconReset size={15} />
      Ricomincia la demo
    </button>
  );
}

export function PolicyUpload({ actorId }: { actorId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setMessage("");
    const form = new FormData();
    form.set("actorId", actorId);
    form.set("file", file);
    const res = await fetch("/api/policy", { method: "POST", body: form });
    const data = (await res.json().catch(() => ({}))) as Json;
    setBusy(false);
    setMessage(res.ok ? `Caricata: ${data.pages} pagine, ${data.sections} sezioni.` : String(data.error ?? "Errore"));
    router.refresh();
  }

  return (
    <div className="upload">
      <label className={`dropzone${busy ? " busy" : ""}`}>
        <span className="row">
          <IconUpload size={16} />
          {busy ? "Leggo il PDF…" : "Carica una nuova policy"}
        </span>
        <span className="muted small">PDF con testo selezionabile · max 5 MB, 100 pagine</span>
        <input type="file" accept="application/pdf" hidden disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
      </label>
      {message && <div className={message.startsWith("Caricata") ? "ok" : "error"}>{message}</div>}
    </div>
  );
}
