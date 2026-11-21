// Demo del suggerimento di policy: crea deroghe hotel già chiuse sulla trasferta T-042, passando dalle stesse
// funzioni dell'app (proposta verificata, motivazione, approvazione del manager, carta simulata, pagamento,
// scontrino e fattura coerenti, approvazione automatica dell'agente).
//   node scripts/demo-suggestion.ts         -> 2 deroghe: la terza la fai tu dalla UI e compare il suggerimento
//   node scripts/demo-suggestion.ts --all   -> 3 deroghe: il suggerimento compare subito in Finance → Policy
// Usa sempre il simulatore delle carte, qualunque sia CARD_PROVIDER. Lancialo dopo «Reset demo».
import { agentTurn } from "../lib/agent.ts";
import { createCardSimulator } from "../lib/card-simulator.ts";
import { DEMO_USERS, openDatabase } from "../lib/db.ts";
import { attachReceipt, confirmProposal, decide, issueCard, listMessages, listSuggestions, payWithCard } from "../lib/flow.ts";
import { formatEuro } from "../lib/format.ts";
import { readPolicy } from "../lib/policy.ts";

const [anna, marco, giulia, paolo] = DEMO_USERS.map((u) => u.id);

// Frase della policy attiva con i limiti hotel per junior e senior (es. «junior 100 euro» o «100 euro per i junior»).
function hotelLimits(text: string) {
  const lines = text.split(/\n|(?<=\.)\s+/).map((l) => l.trim());
  const euro = (line: string, level: string) =>
    Number(
      // prima «100 euro per i junior», poi «junior 100 euro»: l'ordine evita di prendere il numero del livello dopo
      line.match(new RegExp(`(\\d+)\\s*(?:euro|€)\\s*(?:per\\s+i\\s+)?${level}`, "i"))?.[1] ??
        line.match(new RegExp(`${level}\\D{0,12}?(\\d+)\\s*(?:euro|€)`, "i"))?.[1],
    );
  const start = lines.findIndex((l) => /hotel|pernott|allogg/i.test(l));
  for (const line of start < 0 ? [] : lines.slice(start, start + 6)) {
    const junior = euro(line, "junior");
    const senior = euro(line, "senior");
    if (junior > 0 && senior > 0) return { quote: line, juniorCents: junior * 100, seniorCents: senior * 100 };
  }
  throw new Error("Nella policy attiva non trovo i limiti hotel per junior e senior");
}

const db = openDatabase();
const { quote: HOTEL_QUOTE, juniorCents, seniorCents } = hotelLimits(readPolicy(db).text);
// Deroghe da 30 € ciascuna: Anna e Marco sopra il loro limite, poi Anna con il budget hotel già esaurito.
const EXCEPTIONS = [
  { user: anna, name: "Anna", amountCents: juniorCents + 3000, limitCents: juniorCents, why: "La fiera finisce alle 21 e l'unico hotel vicino alla sede costa di più" },
  { user: marco, name: "Marco", amountCents: seniorCents + 3000, limitCents: seniorCents, why: "Durante la fiera gli hotel entro il limite in zona sono tutti pieni" },
  { user: anna, name: "Anna", amountCents: 3000, limitCents: juniorCents, why: "Il secondo giorno di fiera si chiude tardi, serve una notte in più" },
];
const cards = createCardSimulator();
const all = process.argv.includes("--all");
try {
  for (const e of EXCEPTIONS.slice(0, all ? 3 : 2)) {
    const proposal = {
      category: "hotel",
      amountCents: e.amountCents,
      urgency: "day",
      reason: "Hotel per la fiera a Roma",
      limitCents: e.limitCents,
      clauseQuote: HOTEL_QUOTE,
      policyGap: false,
    };
    // Il modello è sostituito da una risposta fissa: il server verifica comunque la proposta sulla policy attiva.
    await agentTurn(db, e.user, `Hotel a Roma per la fiera, ${formatEuro(e.amountCents)}`, async () => ({
      reply: "Ecco la proposta.",
      show: "none",
      proposal,
    }));
    const message = listMessages(db, e.user).filter((m) => m.card && JSON.parse(m.card).type === "proposal").at(-1);
    if (!message?.card) {
      throw new Error("La proposta non è passata dalla verifica: la policy attiva non contiene il limite hotel di esempio. Rimetti la policy di esempio o adatta HOTEL_QUOTE.");
    }
    const request = confirmProposal(db, e.user, message.id, e.why).request;
    if (request.extra_cents === 0) throw new Error(`${e.name}: la richiesta rientra nel budget, non è una deroga. Premi «Reset demo» e riprova.`);
    decide(db, giulia, request.id, "approved");
    await issueCard(db, cards, request.id);
    const paid = await payWithCard(db, cards, e.user, request.id);
    if (!paid.approved) throw new Error(`${e.name}: pagamento simulato rifiutato`);
    const done = attachReceipt(db, e.user, request.id, "exact");
    console.log(`${e.name}: hotel ${formatEuro(e.amountCents)}, deroga ${formatEuro(request.extra_cents)} → ${done.status}`);
  }
  const open = listSuggestions(db, paolo).filter((s) => s.status === "open");
  console.log(
    open.length
      ? `Suggerimenti aperti: ${open.length}. Apri Finance → Policy.`
      : "Nessun suggerimento ancora: fai la terza deroga hotel dalla UI (es. Marco, «una notte in più a Roma per la fiera, l'hotel costa 30 €»).",
  );
} finally {
  db.close();
}
