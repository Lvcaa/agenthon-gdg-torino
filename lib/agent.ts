import type { DatabaseSync } from "node:sqlite";
import { formatEuro } from "./format.ts";
import {
  addMessage,
  assessProposal,
  committedFor,
  createLinkCode,
  getActor,
  listMessages,
  listRequests,
  FlowError,
  type Actor,
  type Card,
} from "./flow.ts";
import { generateJson } from "./gemini.ts";
import { CATEGORIES, excerpts, policyIndex, readPolicy, retrieve, type Policy } from "./policy.ts";
import { verifyProposal, type VerifiedProposal } from "./proposal.ts";

export type Llm = (prompt: string, system: string) => Promise<unknown>;

const MAX_MESSAGE_LENGTH = 1000;
const HISTORY_MESSAGES = 10;
const SHOW_VALUES = ["none", "my_requests", "queue", "registry", "telegram_code", "policy"] as const;
const EXCERPTS_NORMAL = 4;
const EXCERPTS_WIDE = 8;
type Show = (typeof SHOW_VALUES)[number];

interface AgentOutput {
  reply: string;
  show: Show;
  proposal: unknown;
}

function parseOutput(raw: unknown): AgentOutput {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const reply = typeof r.reply === "string" && r.reply.trim() ? r.reply.trim() : "Non ho capito, puoi riformulare?";
  const show = SHOW_VALUES.includes(r.show as Show) ? (r.show as Show) : "none";
  return { reply, show, proposal: r.proposal ?? null };
}

function stateSummary(db: DatabaseSync, actor: Actor): string {
  if (actor.permission === "employee") {
    const spent = CATEGORIES.map((c) => `${c} ${formatEuro(committedFor(db, actor.id, c))}`).join(", ");
    const open = listRequests(db, { userId: actor.id })
      .slice(-8)
      .map((r) => `- ${r.category} ${formatEuro(r.amount_cents)}: ${r.status}`)
      .join("\n");
    return `Già autorizzato in questa trasferta: ${spent}.\nLe tue richieste:\n${open || "- nessuna"}`;
  }
  const statuses = actor.permission === "manager" ? (["pending_manager"] as const) : (["pending_finance", "finance_approved"] as const);
  const queue = listRequests(db, { statuses: [...statuses] })
    .map((r) => `- ${r.employee_name} (${r.employee_role}): ${r.category} ${formatEuro(r.amount_cents)}, extra ${formatEuro(r.extra_cents)}, priorità ${r.priority_label}, stato ${r.status}`)
    .join("\n");
  return `Coda ${actor.permission === "manager" ? "manager" : "Finance"}:\n${queue || "- vuota"}`;
}

function systemPrompt(actor: Actor, policy: Policy, state: string, found: string): string {
  return `Sei l'assistente rimborsi di trasferta di un'azienda. Parli italiano, in modo breve e diretto (massimo 4 frasi).
Stai parlando con ${actor.name}: posizione ${actor.role}, permesso ${actor.permission}.

POLICY AZIENDALE, versione ${policy.version} (${policy.filename}, ${policy.pages} pagine).
Non hai l'intero documento: hai l'indice delle sezioni e gli estratti più pertinenti alla conversazione.

INDICE
${policyIndex(policy)}

ESTRATTI PERTINENTI
"""
${found}
"""

STATO
${state}

COSA FAI
- Rispondi a domande su policy e budget leggendo gli estratti. Non inventare mai limiti, regole o importi che non sono scritti negli estratti. Se il limite non è negli estratti, dillo e usa policyGap invece di indovinare.
- Se il dipendente vuole fare una spesa e conosci categoria e importo, individua nella policy il limite che vale per la sua posizione (${actor.role}), tenendo conto di quanto è già autorizzato nello STATO, e restituisci una proposta.
- Se manca l'importo, la categoria o l'urgenza e non puoi dedurli, chiedi UNA domanda breve e lascia proposal a null. Non restituire proposte finché non sei sicuro.
- Se la policy non copre il caso o la posizione di ${actor.name}, o è ambigua, restituisci la proposta con policyGap true, limitCents null e spiega che deciderà il manager. Non indovinare un limite.
- Quando restituisci una proposta, sotto il tuo messaggio compare una scheda con il pulsante «Conferma invio»: non chiedere «vuoi che prepari la richiesta?», di' invece di controllare la scheda e confermare.
- Non puoi inviare richieste, approvare, rifiutare o esportare: lo fanno i pulsanti sotto i messaggi, dopo la conferma dell'utente. Non dire mai che un'azione è già stata eseguita. Se un manager o Finance chiede di approvare, rimandalo ai pulsanti.
- Solo i dipendenti possono fare richieste. Per manager e Finance proposal è sempre null.

FORMATO: rispondi solo con un JSON con questi campi.
{
  "reply": "testo per l'utente",
  "show": "none" | "my_requests" | "queue" | "registry" | "telegram_code" | "policy",
  "proposal": null | {
    "category": "taxi" | "train" | "meals" | "hotel" | "other",
    "amountCents": numero intero in centesimi,
    "urgency": "immediate" (deve spendere subito) | "day" (entro 24 ore) | "week" (entro 7 giorni) | "later",
    "reason": "motivazione breve",
    "limitCents": limite per la sua posizione in centesimi, oppure null,
    "clauseQuote": "frase copiata parola per parola dalla policy da cui ricavi il limite, oppure null",
    "policyGap": true se la policy non copre il caso, altrimenti false
  }
}
show: "my_requests" mostra le richieste del dipendente, "queue" la coda di manager o Finance, "registry" il registro delle decisioni, "telegram_code" genera il codice per collegare Telegram, "policy" mostra la policy attiva e le sue sezioni. Usa "none" negli altri casi.`;
}

function buildPrompt(history: { role: string; content: string }[], text: string, feedback?: string): string {
  const lines = history.map((m) => `${m.role === "user" ? "Utente" : "Assistente"}: ${m.content}`);
  const feedbackLine = feedback ? `\n\nVERIFICA DEL SERVER FALLITA sulla tua ultima proposta: ${feedback}\nCorreggi la proposta oppure usa policyGap true.` : "";
  return `${lines.join("\n")}${lines.length ? "\n" : ""}Utente: ${text}${feedbackLine}`;
}

interface Asked {
  output: AgentOutput;
  proposal: VerifiedProposal | null;
  degraded: boolean;
}

// Interroga il modello con gli estratti più pertinenti. Se la proposta non regge, un nuovo tentativo con
// l'errore. Se il modello dichiara la policy non chiara, un secondo giro con più estratti: la ricerca potrebbe
// aver perso la sezione giusta. Al massimo due chiamate extra, poi il caso passa al manager.
async function askVerified(
  llm: Llm,
  db: DatabaseSync,
  actor: Actor,
  policy: Policy,
  history: { role: string; content: string }[],
  text: string,
): Promise<Asked> {
  const state = stateSummary(db, actor);
  const query = [...history.filter((m) => m.role === "user").slice(-2).map((m) => m.content), text, actor.role].join(" ");

  const call = async (k: number, feedback?: string) => {
    const found = excerpts(retrieve(policy, query, k));
    return parseOutput(await llm(buildPrompt(history, text, feedback), systemPrompt(actor, policy, state, found)));
  };

  let output = await call(EXCERPTS_NORMAL);
  if (output.proposal === null || output.proposal === undefined) return { output, proposal: null, degraded: false };

  let check = verifyProposal(output.proposal, policy);
  if (check.ok && !check.proposal.policyGap) return { output, proposal: check.proposal, degraded: false };

  if (check.ok) {
    const wide = await call(EXCERPTS_WIDE);
    const wideCheck = wide.proposal ? verifyProposal(wide.proposal, policy) : null;
    if (wideCheck?.ok) return { output: wide, proposal: wideCheck.proposal, degraded: false };
    return { output, proposal: check.proposal, degraded: false };
  }

  output = await call(EXCERPTS_WIDE, check.errors.join("; "));
  if (output.proposal === null || output.proposal === undefined) return { output, proposal: null, degraded: false };
  check = verifyProposal(output.proposal, policy);
  if (check.ok) return { output, proposal: check.proposal, degraded: false };

  // Ancora non verificabile: niente limite inventato, la decisione passa al manager.
  const raw = (output.proposal && typeof output.proposal === "object" ? output.proposal : {}) as Record<string, unknown>;
  const gap = verifyProposal({ ...raw, policyGap: true, limitCents: null, clauseQuote: null }, policy);
  return { output, proposal: gap.ok ? gap.proposal : null, degraded: gap.ok };
}

// Un turno di conversazione: il modello interpreta, il server verifica e salva. Nessuna azione parte da qui.
export async function agentTurn(db: DatabaseSync, actorId: unknown, text: unknown, llm: Llm = generateJson): Promise<void> {
  const actor = getActor(db, actorId);
  const message = typeof text === "string" ? text.trim() : "";
  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    throw new FlowError(400, `Scrivi un messaggio di massimo ${MAX_MESSAGE_LENGTH} caratteri`);
  }

  const history = listMessages(db, actor.id, HISTORY_MESSAGES).map((m) => ({ role: m.role, content: m.content }));
  addMessage(db, actor.id, "user", message);

  const policy = readPolicy(db);
  let result;
  try {
    result = await askVerified(llm, db, actor, policy, history, message);
  } catch (error) {
    console.error(error);
    addMessage(db, actor.id, "assistant", "Non riesco a contattare il modello in questo momento. Riprova tra poco.");
    return;
  }

  const { output, degraded } = result;
  const proposal = actor.permission === "employee" ? result.proposal : null;
  let reply = output.reply;
  let card: Card | null = null;

  if (proposal) {
    if (degraded) reply += " Non ho potuto verificare il limite sulla policy: la richiesta andrà al manager come caso non coperto.";
    const { budget, extra, priority } = assessProposal(db, actor.id, proposal);
    card = { type: "proposal", proposal, budgetCents: budget, extraCents: extra, priority: priority.level, priorityLabel: priority.label };
  } else if (output.show === "my_requests" || (output.show === "queue" && actor.permission === "employee")) {
    const ids = listRequests(db, { userId: actor.id }).slice(-8).map((r) => r.id);
    card = ids.length ? { type: "requests", ids } : null;
  } else if (output.show === "queue") {
    const statuses = actor.permission === "manager" ? (["pending_manager"] as const) : (["pending_finance", "finance_approved"] as const);
    const ids = listRequests(db, { statuses: [...statuses] }).map((r) => r.id);
    card = ids.length ? { type: "requests", ids } : null;
  } else if (output.show === "registry") {
    card = { type: "events" };
  } else if (output.show === "policy") {
    card = { type: "policy", version: policy.version };
  } else if (output.show === "telegram_code") {
    const { code, expiresAt } = createLinkCode(db, actor.id);
    card = { type: "telegram_code", code, expiresAt };
  }

  addMessage(db, actor.id, "assistant", reply, card);
}
