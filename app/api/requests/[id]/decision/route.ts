import { decide } from "../../../../../lib/flow.ts";
import { readBody, withDb, type IdContext } from "../../../../../lib/http.ts";

export const dynamic = "force-dynamic";

// Il canale è sempre "web": il canale Telegram lo imposta solo il codice del bot, non il client.
export async function POST(request: Request, { params }: IdContext) {
  const [{ id }, body] = await Promise.all([params, readBody(request)]);
  return withDb((db) => decide(db, body.actorId, id, body.decision, "web"));
}
