import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { FlowError, cardView, issueCard } from "./flow.ts";
import { cardProviderFromEnv } from "./card-provider.ts";
import type { StripeIssuing } from "./stripe.ts";

export type Body = Record<string, unknown>;
export type IdContext = { params: Promise<{ id: string }> };

export async function readBody(request: Request): Promise<Body> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Body) : {};
  } catch {
    return {};
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof FlowError) return Response.json({ ok: false, error: error.message }, { status: error.status });
  console.error(error);
  return Response.json({ ok: false, error: "Errore interno" }, { status: 500 });
}

// Apre il database per la durata della chiamata e traduce gli errori del flusso in risposte HTTP.
export function withDb(fn: (db: DatabaseSync) => Response | object): Response {
  const db = openDatabase();
  try {
    const result = fn(db);
    return result instanceof Response ? result : Response.json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  } finally {
    db.close();
  }
}

export async function withDbAsync(fn: (db: DatabaseSync) => Promise<object>): Promise<Response> {
  const db = openDatabase();
  try {
    return Response.json({ ok: true, ...(await fn(db)) });
  } catch (error) {
    return errorResponse(error);
  } finally {
    db.close();
  }
}

// Provider di carte dall'ambiente. Una configurazione non valida (es. chiave non sandbox) conta come «non configurato».
export function sandboxStripe(): StripeIssuing | null {
  try {
    return cardProviderFromEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return null;
  }
}

// Dopo la funzione sync di conferma o decisione: se la pratica ha una carta in attesa, la genera su Stripe.
export async function issueIfPending(db: DatabaseSync, requestId: string): Promise<void> {
  if (cardView(db, requestId).card?.status === "pending") await issueCard(db, sandboxStripe(), requestId);
}
