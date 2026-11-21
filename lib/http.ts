import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { FlowError } from "./flow.ts";

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
