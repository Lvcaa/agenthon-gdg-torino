// Client REST minimale per Stripe Issuing (solo sandbox), senza SDK.
import { createHmac, timingSafeEqual } from "node:crypto";

const API_BASE = "https://api.stripe.com/v1";
// Versione verificata sulla documentazione Stripe (nov 2026). Sovrascrivibile con STRIPE_API_VERSION.
export const STRIPE_API_VERSION = "2026-11-18.endive";

export interface IssuedCard { id: string; last4: string; expMonth: number; expYear: number; status: "active" | "inactive" | "canceled" }
export interface CapturedTransaction {
  id: string;
  cardId: string;
  authorizationId: string | null;
  amountCents: number;
  merchantName: string; merchantCategory: string; merchantCity: string | null;
  createdIso: string;
  raw: unknown;
}
export type SimulatedPayment =
  | { approved: true; transaction: CapturedTransaction }
  | { approved: false; authorizationId: string; reason: string };

export interface StripeIssuing {
  ensureCardholder(input: { userId: string; name: string; email: string; existingId: string | null }): Promise<string>;
  createCard(input: { requestId: string; cardholderId: string; limitCents: number; allowedCategories: string[] }): Promise<IssuedCard>;
  deactivateCard(cardId: string): Promise<void>;
  simulatePayment(input: { cardId: string; amountCents: number; merchantName: string; merchantCategory: string; merchantCity: string; idempotencyKey: string }): Promise<SimulatedPayment>;
}

// Nomi delle categorie verificati sull'enum `spending_controls.allowed_categories` (docs Stripe).
// `business_services_not_elsewhere_classified` NON esiste: l'MCC 7399 e' `miscellaneous_business_services`.
// Il treno ha due MCC (4011 merci/passeggeri, 4112 passeggeri): `railroads` e `passenger_railways`.
export const STRIPE_CATEGORIES_VERIFIED: readonly string[] = [
  "taxicabs_limousines",
  "railroads",
  "passenger_railways",
  "eating_places_restaurants",
  "fast_food_restaurants",
  "hotels_motels_and_resorts",
  "car_rental_agencies",
  "service_stations",
  "automated_fuel_dispensers",
  "miscellaneous_business_services",
];

type FormValue = string | number | boolean | null | undefined | FormValue[] | { [k: string]: FormValue };
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Codifica un oggetto in application/x-www-form-urlencoded con notazione a parentesi di Stripe. */
export function encodeForm(data: { [k: string]: FormValue }): string {
  const pairs: string[] = [];
  const walk = (prefix: string, v: FormValue) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        const isObj = item !== null && typeof item === "object";
        walk(isObj ? `${prefix}[${i}]` : `${prefix}[]`, item);
      });
    } else if (typeof v === "object") {
      for (const [k, child] of Object.entries(v)) walk(`${prefix}[${k}]`, child);
    } else {
      pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
    }
  };
  for (const [k, v] of Object.entries(data)) walk(k, v);
  return pairs.join("&");
}

/** Sandbox soltanto: rifiuta chiavi live o restricted. */
export function stripeFromEnv(): StripeIssuing | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return createStripeIssuing(key, fetch, regionFromEnv());
}

// Profilo di paese della sandbox. Issuing non è disponibile per gli account con sede in Italia,
// quindi la demo usa un account di test USA: STRIPE_REGION=us (valuta USD, indirizzi USA).
export type StripeRegion = "eu" | "us";
export const REGION_PROFILES = {
  eu: {
    currency: "eur",
    phone: "+390111234567", // obbligatorio in UE per SCA (dato sintetico)
    address: { line1: "Via Roma 1", city: "Torino", postal_code: "10121", state: "TO", country: "IT" },
    merchantCountry: "IT",
  },
  us: {
    currency: "usd",
    phone: "+14155550100",
    address: { line1: "1 Market St", city: "San Francisco", postal_code: "94105", state: "CA", country: "US" },
    merchantCountry: "US",
  },
} as const;

export function regionFromEnv(): StripeRegion {
  return process.env.STRIPE_REGION === "us" ? "us" : "eu";
}

export function createStripeIssuing(secretKey: string, fetchImpl: FetchLike = fetch, region: StripeRegion = "eu"): StripeIssuing {
  const profile = REGION_PROFILES[region];
  if (!secretKey.startsWith("sk_test_")) {
    throw new Error("STRIPE_SECRET_KEY deve iniziare con sk_test_: sono ammesse solo chiavi sandbox");
  }
  const version = process.env.STRIPE_API_VERSION || STRIPE_API_VERSION;

  async function call(method: "GET" | "POST", path: string, data?: { [k: string]: FormValue }, idempotencyKey?: string): Promise<any> {
    const headers: Record<string, string> = { authorization: `Bearer ${secretKey}`, "stripe-version": version };
    let url = `${API_BASE}${path}`;
    let body: string | undefined;
    if (method === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = encodeForm(data ?? {});
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    } else if (data) {
      url += `?${encodeForm(data)}`;
    }
    const res = await fetchImpl(url, { method, headers, body });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json?.error?.message ?? "errore";
      throw new Error(`Stripe ${res.status} (${method} ${path}): ${msg}`);
    }
    return json;
  }

  const toCard = (c: any): IssuedCard => ({
    id: c.id, last4: c.last4, expMonth: c.exp_month, expYear: c.exp_year, status: c.status,
  });

  return {
    async ensureCardholder({ userId, name, email, existingId }) {
      if (existingId) return existingId;
      const parts = name.trim().split(/\s+/);
      const firstName = parts[0] || name;
      const lastName = parts.slice(1).join(" ") || firstName;
      const ch = await call("POST", "/issuing/cardholders", {
        type: "individual",
        name,
        email,
        phone_number: profile.phone,
        status: "active",
        individual: { first_name: firstName, last_name: lastName, dob: { day: 1, month: 1, year: 1990 } },
        billing: { address: profile.address },
        metadata: { user_id: userId },
      }, `cardholder-${userId}`);
      // Le user terms servono solo per alcuni programmi (es. Celtic Bank): le inviamo se richieste.
      const past: string[] = ch.requirements?.past_due ?? [];
      if (past.some((r) => r.startsWith("individual.card_issuing.user_terms_acceptance"))) {
        await call("POST", `/issuing/cardholders/${ch.id}`, {
          individual: { card_issuing: { user_terms_acceptance: { date: Math.floor(Date.now() / 1000), ip: "203.0.113.10" } } },
        });
      }
      return ch.id as string;
    },

    async createCard({ requestId, cardholderId, limitCents, allowedCategories }) {
      const card = await call("POST", "/issuing/cards", {
        cardholder: cardholderId,
        currency: profile.currency,
        type: "virtual",
        status: "active",
        spending_controls: {
          spending_limits: [{ amount: limitCents, interval: "all_time" }],
          allowed_categories: allowedCategories.length ? allowedCategories : undefined,
        },
        metadata: { request_id: requestId },
      }, `card-${requestId}`);
      return toCard(card);
    },

    async deactivateCard(cardId) {
      await call("POST", `/issuing/cards/${cardId}`, { status: "inactive" });
    },

    async simulatePayment({ cardId, amountCents, merchantName, merchantCategory, merchantCity, idempotencyKey }) {
      const auth = await call("POST", "/test_helpers/issuing/authorizations", {
        card: cardId,
        amount: amountCents,
        currency: profile.currency,
        authorization_method: "online",
        merchant_data: { name: merchantName, category: merchantCategory, city: merchantCity, country: profile.merchantCountry, network_id: "1234567890" },
      }, `${idempotencyKey}-auth`);
      if (!auth.approved) {
        const history: any[] = auth.request_history ?? [];
        const reason = history[history.length - 1]?.reason ?? auth.status ?? "rifiutata";
        return { approved: false, authorizationId: auth.id, reason: String(reason) };
      }
      const captured = await call("POST", `/test_helpers/issuing/authorizations/${auth.id}/capture`, {}, `${idempotencyKey}-capture`);
      let tx: any = (captured.transactions ?? auth.transactions ?? [])[0];
      if (typeof tx === "string") tx = await call("GET", `/issuing/transactions/${tx}`);
      if (!tx) {
        const list = await call("GET", "/issuing/transactions", { card: cardId, limit: 1 });
        tx = list.data?.[0];
      }
      if (!tx) throw new Error("Stripe: transazione non trovata dopo la cattura");
      return { approved: true, transaction: transactionFromStripe(tx) };
    },
  };
}

/** Verifica l'header Stripe-Signature (t=...,v1=...). Restituisce l'evento JSON o lancia. */
export function verifyWebhook(payload: string, signatureHeader: string | null, secret: string, toleranceSec = 300): unknown {
  if (!signatureHeader) throw new Error("Firma webhook mancante");
  let t = "";
  const sigs: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v);
  }
  const ts = Number(t);
  if (!t || !Number.isFinite(ts) || sigs.length === 0) throw new Error("Firma webhook malformata");
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest();
  const ok = sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw new Error("Firma webhook non valida");
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) throw new Error("Firma webhook scaduta");
  return JSON.parse(payload);
}

/** Mappa un oggetto issuing.transaction. Per gli acquisti Stripe usa importi negativi: restituiamo il valore assoluto. */
export function transactionFromStripe(obj: unknown): CapturedTransaction {
  const t = obj as any;
  if (!t || typeof t.id !== "string" || typeof t.amount !== "number") throw new Error("Oggetto issuing.transaction non valido");
  const card = typeof t.card === "string" ? t.card : t.card?.id;
  const auth = typeof t.authorization === "string" ? t.authorization : t.authorization?.id;
  const md = t.merchant_data ?? {};
  return {
    id: t.id,
    cardId: card,
    authorizationId: auth ?? null,
    amountCents: Math.abs(t.amount),
    merchantName: md.name ?? "",
    merchantCategory: md.category ?? "",
    merchantCity: md.city ?? null,
    createdIso: new Date((t.created ?? 0) * 1000).toISOString(),
    raw: obj,
  };
}
