import { decideSuggestion } from "../../../../../lib/flow.ts";
import { readBody, withDb, type IdContext } from "../../../../../lib/http.ts";

export const dynamic = "force-dynamic";

// Solo Finance: accetta o ignora un suggerimento di policy (`decision`: accepted, dismissed). Idempotente.
export async function POST(request: Request, { params }: IdContext) {
  const [{ id }, body] = await Promise.all([params, readBody(request)]);
  return withDb((db) => decideSuggestion(db, body.actorId, id, body.decision));
}
