import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CapturedTransaction, IssuedCard, SimulatedPayment, StripeIssuing } from "./stripe.ts";

// Emittente di carte simulato, senza rete: stessa interfaccia del provider reale.
// Applica le stesse regole di una carta monouso vera: limite all_time, categorie ammesse, carta attiva.
// Lo stato sta in un file JSON perché ogni richiesta HTTP apre un nuovo contesto.

interface SimCard extends IssuedCard {
  requestId: string;
  cardholderId: string;
  limitCents: number;
  spentCents: number;
  allowedCategories: string[];
}

interface SimState {
  seq: number;
  cards: Record<string, SimCard>;
  cardByRequest: Record<string, string>;
  payments: Record<string, SimulatedPayment>;
}

const empty = (): SimState => ({ seq: 0, cards: {}, cardByRequest: {}, payments: {} });

export function createCardSimulator(file = join(process.cwd(), "data", "card-simulator.json")): StripeIssuing {
  const load = (): SimState => {
    try {
      return { ...empty(), ...(JSON.parse(readFileSync(file, "utf8")) as SimState) };
    } catch {
      return empty();
    }
  };
  const save = (state: SimState) => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, file);
  };
  const id = (prefix: string) => `${prefix}_sim_${randomBytes(6).toString("hex")}`;

  return {
    async ensureCardholder({ userId, existingId }) {
      return existingId ?? `ich_sim_${userId.slice(0, 8)}`;
    },

    async createCard({ requestId, cardholderId, limitCents, allowedCategories }) {
      if (!Number.isInteger(limitCents) || limitCents <= 0) throw new Error("Simulatore: limite non valido");
      const state = load();
      const existing = state.cardByRequest[requestId];
      if (existing && state.cards[existing]) return publicCard(state.cards[existing]);
      state.seq += 1;
      const card: SimCard = {
        id: id("ic"),
        last4: String(4000 + (state.seq % 6000)).padStart(4, "0"),
        expMonth: 12,
        expYear: new Date().getFullYear() + 3,
        status: "active",
        requestId,
        cardholderId,
        limitCents,
        spentCents: 0,
        allowedCategories,
      };
      state.cards[card.id] = card;
      state.cardByRequest[requestId] = card.id;
      save(state);
      return publicCard(card);
    },

    async deactivateCard(cardId) {
      const state = load();
      const card = state.cards[cardId];
      if (!card) throw new Error("Simulatore: carta sconosciuta");
      card.status = "inactive";
      save(state);
    },

    async simulatePayment({ cardId, amountCents, merchantName, merchantCategory, merchantCity, idempotencyKey }) {
      const state = load();
      const done = state.payments[idempotencyKey];
      if (done) return done;
      const card = state.cards[cardId];
      const authorizationId = id("iauth");
      let result: SimulatedPayment;
      if (!card) result = { approved: false, authorizationId, reason: "card_not_found" };
      else if (card.status !== "active") result = { approved: false, authorizationId, reason: "card_inactive" };
      else if (card.allowedCategories.length && !card.allowedCategories.includes(merchantCategory)) {
        result = { approved: false, authorizationId, reason: "merchant_category_not_allowed" };
      } else if (card.spentCents + amountCents > card.limitCents) {
        result = { approved: false, authorizationId, reason: "spending_controls" };
      } else {
        card.spentCents += amountCents;
        const transaction: CapturedTransaction = {
          id: id("ipi"),
          cardId,
          authorizationId,
          amountCents,
          merchantName,
          merchantCategory,
          merchantCity,
          createdIso: new Date().toISOString(),
          raw: { object: "issuing.transaction", provider: "simulator" },
        };
        result = { approved: true, transaction };
      }
      state.payments[idempotencyKey] = result;
      save(state);
      return result;
    },
  };
}

function publicCard(card: SimCard): IssuedCard {
  return { id: card.id, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear, status: card.status };
}
