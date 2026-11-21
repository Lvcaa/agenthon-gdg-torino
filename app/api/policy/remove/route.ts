import { removePolicy } from "../../../../lib/flow.ts";
import { readBody, withDb } from "../../../../lib/http.ts";

export const dynamic = "force-dynamic";

// Solo Finance: rimuove la policy attiva. Senza policy l'assistente non propone richieste finché non se ne carica una.
export async function POST(request: Request) {
  const body = await readBody(request);
  return withDb((db) => removePolicy(db, body.actorId));
}
