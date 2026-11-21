import type { CapturedTransaction, IssuedCard, SimulatedPayment, StripeIssuing } from "../../lib/stripe.ts";
import { issueCard, payWithCard } from "../../lib/flow.ts";
import type { DatabaseSync } from "node:sqlite";

export interface FakeCall {
  method: "ensureCardholder" | "createCard" | "deactivateCard" | "simulatePayment";
  input: unknown;
}

// Finto Stripe Issuing: registra le chiamate, rispetta il limite della carta e genera id ic_/ipi_.
export interface FakeStripe extends StripeIssuing {
  calls: FakeCall[];
  cards: Map<string, IssuedCard & { limitCents: number; requestId: string; allowedCategories: string[] }>;
  transactions: CapturedTransaction[];
  failCreate: boolean;
}

export function fakeStripe(): FakeStripe {
  let seq = 0;
  const byRequest = new Map<string, string>();
  const byKey = new Map<string, SimulatedPayment>();
  const fake: FakeStripe = {
    calls: [],
    cards: new Map(),
    transactions: [],
    failCreate: false,
    async ensureCardholder(input) {
      fake.calls.push({ method: "ensureCardholder", input });
      return input.existingId ?? `ich_${input.userId.slice(0, 8)}`;
    },
    async createCard(input) {
      fake.calls.push({ method: "createCard", input });
      if (fake.failCreate) throw new Error("Stripe non raggiungibile");
      const existing = byRequest.get(input.requestId);
      if (existing) return fake.cards.get(existing)!;
      const id = `ic_fake_${++seq}`;
      const card = {
        id,
        last4: String(4000 + seq),
        expMonth: 12,
        expYear: 2030,
        status: "active" as const,
        limitCents: input.limitCents,
        requestId: input.requestId,
        allowedCategories: input.allowedCategories,
      };
      fake.cards.set(id, card);
      byRequest.set(input.requestId, id);
      return card;
    },
    async deactivateCard(cardId) {
      fake.calls.push({ method: "deactivateCard", input: cardId });
      fake.cards.get(cardId)!.status = "inactive";
    },
    async simulatePayment(input) {
      fake.calls.push({ method: "simulatePayment", input });
      const done = byKey.get(input.idempotencyKey);
      if (done) return done;
      const card = fake.cards.get(input.cardId);
      let result: SimulatedPayment;
      if (!card || card.status !== "active") {
        result = { approved: false, authorizationId: `iauth_fake_${++seq}`, reason: "card_inactive" };
      } else if (input.amountCents > card.limitCents) {
        result = { approved: false, authorizationId: `iauth_fake_${++seq}`, reason: "spending_controls" };
      } else {
        const transaction: CapturedTransaction = {
          id: `ipi_fake_${++seq}`,
          cardId: card.id,
          authorizationId: `iauth_fake_${++seq}`,
          amountCents: input.amountCents,
          merchantName: input.merchantName,
          merchantCategory: input.merchantCategory,
          merchantCity: input.merchantCity,
          createdIso: new Date().toISOString(),
          raw: { object: "issuing.transaction" },
        };
        fake.transactions.push(transaction);
        result = { approved: true, transaction };
      }
      byKey.set(input.idempotencyKey, result);
      return result;
    },
  };
  return fake;
}

// Genera la carta e paga l'importo autorizzato, come farebbero le route dopo l'approvazione.
export async function settleCard(db: DatabaseSync, stripe: FakeStripe, actorId: string, requestId: string, amountCents?: number) {
  await issueCard(db, stripe, requestId);
  return payWithCard(db, stripe, actorId, requestId, amountCents);
}
