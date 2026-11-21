// Client REST minimale per Lithic (solo sandbox), senza SDK. Implementa il contratto StripeIssuing.
import type { CapturedTransaction, IssuedCard, SimulatedPayment, StripeIssuing } from "./stripe.ts";

const SANDBOX_BASE = "https://sandbox.lithic.com";
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// Nomi categoria Stripe -> MCC (ISO 18245).
export const STRIPE_CATEGORY_MCC: Record<string, string> = {
  taxicabs_limousines: "4121",
  railroads: "4011",
  passenger_railways: "4112",
  eating_places_restaurants: "5812",
  fast_food_restaurants: "5814",
  hotels_motels_and_resorts: "7011",
  car_rental_agencies: "7512",
  service_stations: "5541",
  automated_fuel_dispensers: "5542",
  miscellaneous_business_services: "7399",
  miscellaneous_general_services: "7299",
};

export function mccsFor(categories: string[]): string[] {
  const out: string[] = [];
  for (const c of categories) {
    const m = STRIPE_CATEGORY_MCC[c];
    if (!m) throw new Error(`Categoria senza MCC Lithic: ${c}`);
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

export function lithicFromEnv(): StripeIssuing | null {
  const key = process.env.LITHIC_API_KEY;
  if (!key) return null;
  const base = process.env.LITHIC_BASE_URL;
  return createLithicIssuing(key, fetch, base && base.includes("sandbox") ? base : SANDBOX_BASE);
}

const STATE: Record<string, IssuedCard["status"]> = { OPEN: "active", PAUSED: "inactive", CLOSED: "canceled" };

export function createLithicIssuing(apiKey: string, fetchImpl: FetchLike = fetch, baseUrl = SANDBOX_BASE): StripeIssuing {
  let host: string;
  try { host = new URL(baseUrl).hostname; } catch { throw new Error("LITHIC base URL non valida"); }
  if (!host.includes("sandbox")) throw new Error("Lithic: sono ammesse solo base URL sandbox");
  const base = baseUrl.replace(/\/+$/, "");

  // Stato in memoria: PAN (mai loggato ne' restituito) e MCC ammessi per carta, risultati per idempotenza.
  const pans = new Map<string, string>();
  const allowedMcc = new Map<string, string[]>();
  const payments = new Map<string, SimulatedPayment>();

  async function call(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, idempotencyKey?: string): Promise<any> {
    const headers: Record<string, string> = { authorization: apiKey, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json?.message ?? json?.error?.message ?? json?.detail ?? "errore";
      throw new Error(`Lithic ${res.status} (${method} ${path}): ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
    }
    return json;
  }

  // La sandbox registra la transazione in modo asincrono (~1-2 s dopo authorize): riprova sul 404.
  async function getTransaction(token: string): Promise<any> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call("GET", `/v1/transactions/${token}`);
      } catch (error) {
        const notYet = error instanceof Error && error.message.startsWith("Lithic 404");
        if (!notYet || attempt >= 12) throw error;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  async function panOf(cardId: string): Promise<string> {
    let pan = pans.get(cardId);
    if (!pan) {
      const c = await call("GET", `/v1/cards/${cardId}`);
      pan = c?.pan;
      if (!pan) throw new Error(`Lithic: PAN non disponibile per la carta ${cardId}`);
      pans.set(cardId, pan);
    }
    return pan;
  }

  // Uuid per Idempotency-Key: Lithic documenta un UUID; deriviamo uno stabile dalla chiave logica.
  function toUuid(key: string): string {
    let h = "";
    for (let i = 0; i < 4; i++) {
      let x = 2166136261 ^ i;
      for (const ch of key) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
      h += x.toString(16).padStart(8, "0");
    }
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }

  return {
    // Lithic non richiede un cardholder per le carte sandbox: id sintetico stabile, nessuna chiamata.
    async ensureCardholder({ userId, existingId }) {
      return existingId ?? `lithic-holder-${userId}`;
    },

    async createCard({ requestId, limitCents, allowedCategories }) {
      const mccs = mccsFor(allowedCategories);
      const c = await call("POST", "/v1/cards", {
        type: "SINGLE_USE",
        spend_limit: limitCents,
        spend_limit_duration: "TRANSACTION",
        memo: requestId,
        state: "OPEN",
      }, toUuid(`card-${requestId}`));
      if (c.pan) pans.set(c.token, c.pan);
      if (mccs.length) {
        allowedMcc.set(c.token, mccs);
        // Best effort: regola server-side per carta (v2, bozza + promozione). Il controllo client resta comunque attivo.
        try {
          const rule = await call("POST", "/v2/auth_rules", {
            type: "CONDITIONAL_ACTION",
            event_stream: "AUTHORIZATION",
            card_tokens: [c.token],
            parameters: {
              action: { type: "DECLINE", code: "MERCHANT_BLACKLIST" },
              conditions: [{ attribute: "MCC", operation: "IS_NOT_ONE_OF", value: mccs }],
            },
          });
          if (rule?.token) await call("POST", `/v2/auth_rules/${rule.token}/promote`);
        } catch { /* sandbox senza Auth Rules: resta il controllo MCC lato client */ }
      }
      return {
        id: c.token, last4: c.last_four, expMonth: Number(c.exp_month), expYear: Number(c.exp_year),
        status: STATE[c.state] ?? "inactive",
      };
    },

    // PAUSED: reversibile e coerente con "inactive"; una monouso usata e' gia' CLOSED da Lithic.
    async deactivateCard(cardId) {
      await call("PATCH", `/v1/cards/${cardId}`, { state: "PAUSED" });
    },

    async simulatePayment({ cardId, amountCents, merchantName, merchantCategory, merchantCity, idempotencyKey }) {
      const cached = payments.get(idempotencyKey);
      if (cached) return cached;

      const mcc = STRIPE_CATEGORY_MCC[merchantCategory];
      if (!mcc) throw new Error(`Categoria senza MCC Lithic: ${merchantCategory}`);
      const allowed = allowedMcc.get(cardId);
      let result: SimulatedPayment;
      if (allowed && !allowed.includes(mcc)) {
        result = { approved: false, authorizationId: `local-${idempotencyKey}`, reason: "MERCHANT_CATEGORY_NOT_ALLOWED" };
      } else {
        const pan = await panOf(cardId);
        const auth = await call("POST", "/v1/simulate/authorize", {
          pan, amount: amountCents, descriptor: merchantName.slice(0, 25), mcc,
          merchant_acceptor_city: merchantCity.slice(0, 13), merchant_currency: "USD", merchant_amount: amountCents, status: "AUTHORIZATION",
        });
        const token: string = auth.token;
        let tx = await getTransaction(token);
        if (tx.result !== "APPROVED") {
          result = { approved: false, authorizationId: token, reason: String(tx.result ?? "DECLINED") };
        } else {
          await call("POST", "/v1/simulate/clearing", { token, amount: amountCents });
          tx = await getTransaction(token);
          result = { approved: true, transaction: toTransaction(tx, token, cardId, amountCents, merchantName, merchantCategory, merchantCity) };
        }
      }
      payments.set(idempotencyKey, result);
      return result;
    },
  };
}

function toTransaction(tx: any, token: string, cardId: string, amountCents: number, name: string, category: string, city: string): CapturedTransaction {
  const m = tx.merchant ?? {};
  const created = tx.created ? new Date(tx.created) : new Date();
  return {
    id: tx.token ?? token,
    cardId: tx.card_token ?? cardId,
    authorizationId: tx.token ?? token,
    amountCents: Math.abs(typeof tx.amount === "number" && tx.amount !== 0 ? tx.amount : amountCents),
    merchantName: m.descriptor ?? name,
    merchantCategory: category,
    merchantCity: m.city ?? city ?? null,
    createdIso: Number.isNaN(created.getTime()) ? new Date().toISOString() : created.toISOString(),
    raw: tx,
  };
}
