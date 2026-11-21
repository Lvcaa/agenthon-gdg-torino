"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

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

function ActionButton(props: { label: string; url: string; body: Json; kind?: "danger" }) {
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
      <button onClick={download}>Scarica CSV</button>
      {message && <span className="error">{message}</span>}
    </span>
  );
}

function Quote({ text }: { text: string | null }) {
  return text ? <blockquote>{text}</blockquote> : null;
}

function Card({ card, actorId, permission }: { card: CardData; actorId: string; permission: string }) {
  if (card.type === "proposal") {
    return (
      <div className="card">
        <strong>
          {card.category} · {card.amount}
        </strong>{" "}
        <span className={`tag p${card.priority}`}>{card.priorityLabel}</span>
        <div className="muted">
          {card.limit ? `limite ${card.limit}` : "limite non definito dalla policy"} · residuo {card.budget} · extra{" "}
          <strong>{card.extra}</strong>
        </div>
        <div className="muted">{card.clause}</div>
        <Quote text={card.quote} />
        {card.policyGap && <div className="notice">Policy non chiara su questo caso: deciderà il manager.</div>}
        {card.confirmedStatus ? (
          <div className="muted">Inviata · {card.confirmedStatus}</div>
        ) : (
          <ActionButton label="Conferma invio" url="/api/chat/confirm" body={{ actorId, messageId: card.messageId }} />
        )}
      </div>
    );
  }

  if (card.type === "requests") {
    return (
      <div className="cards">
        {card.items.map((r) => (
          <div className="card" key={r.id}>
            <strong>
              {r.employee} · {r.category} · {r.amount}
            </strong>{" "}
            <span className={`tag p${r.priority}`}>{r.priorityLabel}</span>
            <div className="muted">
              budget {r.budget} · extra {r.extra} · {r.clause}
            </div>
            <Quote text={r.quote} />
            {r.policyGap && <div className="notice">Policy non chiara su questo caso.</div>}
            <div>{r.statusLabel}</div>
            <div>
              {permission === "manager" && r.status === "pending_manager" && (
                <>
                  <ActionButton label="Approva" url={`/api/requests/${r.id}/decision`} body={{ actorId, decision: "approved" }} />
                  <ActionButton label="Rifiuta" kind="danger" url={`/api/requests/${r.id}/decision`} body={{ actorId, decision: "rejected" }} />
                </>
              )}
              {permission === "employee" && r.status === "approved" && (
                <>
                  <ActionButton label={`Ricevuta ${r.authorized}`} url={`/api/requests/${r.id}/receipt`} body={{ actorId, kind: "exact" }} />
                  <ActionButton label={`Ricevuta ${r.overAuthorized}`} url={`/api/requests/${r.id}/receipt`} body={{ actorId, kind: "over" }} />
                </>
              )}
              {permission === "finance" && r.status === "pending_finance" && (
                <ActionButton label="Approva rimborso" url={`/api/requests/${r.id}/finance`} body={{ actorId }} />
              )}
              {permission === "finance" && ["pending_finance", "finance_approved", "exported"].includes(r.status) && (
                <CsvButton requestId={r.id} actorId={actorId} />
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (card.type === "events") {
    return (
      <div className="card">
        {card.items.length === 0 && <span className="muted">Nessun evento.</span>}
        {card.items.map((e) => (
          <div key={e.id} className="event">
            <span className="muted">{e.time}</span> <strong>{e.type}</strong> · {e.actor}
            {e.request && <span className="muted"> · {e.request}</span>}
            {e.details && <div className="muted">{e.details}</div>}
          </div>
        ))}
      </div>
    );
  }

  if (card.type === "policy") {
    return (
      <div className="card">
        <strong>{card.filename}</strong> · versione {card.version} · {card.pages} pagine {card.active ? "· attiva" : "· non più attiva"}
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
    <div className="card">
      Codice per il bot Telegram: <strong className="code">{card.code}</strong>
      <div className="muted">Valido fino alle {new Date(card.expiresAt).toLocaleTimeString("it-IT")}. Mandalo al bot.</div>
    </div>
  );
}

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
      <div className="messages">
        {props.messages.length === 0 && <p className="muted">{props.placeholder}</p>}
        {props.messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            <div className="text">{m.content}</div>
            {m.card && <Card card={m.card} actorId={props.actorId} permission={props.permission} />}
            <div className="time">{m.time}</div>
          </div>
        ))}
        {pending && <div className="bubble assistant muted">Sto leggendo la policy…</div>}
        <div ref={bottom} />
      </div>
      {error && <div className="error">{error}</div>}
      <form onSubmit={send} className="composer">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Scrivi un messaggio" maxLength={1000} autoFocus />
        <button type="submit" disabled={pending}>
          Invia
        </button>
      </form>
    </div>
  );
}

export function ResetButton(): ReactNode {
  const router = useRouter();
  return (
    <button
      className="danger"
      onClick={async () => {
        await post("/api/demo/reset", {});
        router.refresh();
      }}
    >
      Reset demo
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
        {busy ? "Sto leggendo il PDF…" : "Carica la policy in PDF"}
        <span className="muted small">Testo selezionabile, massimo 5 MB e 100 pagine</span>
        <input type="file" accept="application/pdf" hidden disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
      </label>
      {message && <div className={message.startsWith("Caricata") ? "ok" : "error"}>{message}</div>}
    </div>
  );
}
