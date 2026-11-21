import { decide } from "../../../../../lib/flow.ts";
import { issueIfPending, readBody, withDbAsync, type IdContext } from "../../../../../lib/http.ts";

export const dynamic = "force-dynamic";

// Il canale è sempre "web": il canale Telegram lo imposta solo il codice del bot, non il client.
// Una pratica approvata genera la carta dopo il commit.
export async function POST(request: Request, { params }: IdContext) {
  const [{ id }, body] = await Promise.all([params, readBody(request)]);
  return withDbAsync(async (db) => {
    const result = decide(db, body.actorId, id, body.decision, "web");
    await issueIfPending(db, id);
    return result;
  });
}
