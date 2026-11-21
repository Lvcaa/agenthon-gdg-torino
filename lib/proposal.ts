import { CATEGORIES, findSection, type Category, type Policy } from "./policy.ts";

export type Urgency = "immediate" | "day" | "week" | "later";
export const URGENCIES: Urgency[] = ["immediate", "day", "week", "later"];

export const MAX_AMOUNT_CENTS = 10_000_000;
const MAX_LIMIT_CENTS = 10_000_000;

// Quello che l'agente propone quando è sicuro. Il server non lo prende per buono: lo verifica.
export interface Proposal {
  category: Category;
  amountCents: number;
  urgency: Urgency;
  reason: string;
  limitCents: number | null; // limite applicabile al profilo, letto dalla policy; null se la policy non copre il caso
  clauseQuote: string | null; // citazione testuale della policy
  policyGap: boolean; // true: policy assente o ambigua, decide il manager
}

export interface VerifiedProposal extends Proposal {
  clauseRef: string; // titolo della sezione che contiene la citazione, trovato dal server
  policyVersion: string;
}

export type VerifyResult = { ok: true; proposal: VerifiedProposal } | { ok: false; errors: string[] };

function numbersIn(text: string): number[] {
  return (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => Math.round(parseFloat(n.replace(",", ".")) * 100));
}

export function verifyProposal(raw: unknown, policy: Policy): VerifyResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];

  const category = r.category as Category;
  if (!CATEGORIES.includes(category)) errors.push(`category deve essere una tra ${CATEGORIES.join(", ")}`);

  const amount = r.amountCents;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT_CENTS) {
    errors.push("amountCents deve essere un intero positivo in centesimi");
  }

  const urgency = r.urgency as Urgency;
  if (!URGENCIES.includes(urgency)) errors.push(`urgency deve essere una tra ${URGENCIES.join(", ")}`);

  const reason = typeof r.reason === "string" ? r.reason.trim() : "";
  if (!reason || reason.length > 500) errors.push("reason è obbligatoria, massimo 500 caratteri");

  const quote = typeof r.clauseQuote === "string" ? r.clauseQuote.trim() : "";
  const section = quote ? findSection(policy, quote) : null;
  const policyGap = r.policyGap === true;
  let limitCents: number | null = null;

  if (!policyGap) {
    limitCents = typeof r.limitCents === "number" ? r.limitCents : NaN;
    if (!Number.isInteger(limitCents) || limitCents <= 0 || limitCents > MAX_LIMIT_CENTS) {
      errors.push("limitCents deve essere un intero positivo in centesimi, oppure imposta policyGap a true");
    } else if (!quote) {
      errors.push("clauseQuote è obbligatoria quando indichi un limite");
    } else if (!section) {
      errors.push("clauseQuote non compare nella policy: copiala parola per parola");
    } else if (!numbersIn(quote).includes(limitCents)) {
      errors.push("limitCents non corrisponde a nessun importo scritto in clauseQuote");
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    proposal: {
      category,
      amountCents: amount as number,
      urgency,
      reason,
      limitCents: policyGap ? null : limitCents,
      clauseQuote: section ? quote : null,
      policyGap,
      clauseRef: section ?? "Policy non chiara",
      policyVersion: policy.version,
    },
  };
}
