import { financeApprove } from "../../../../../lib/flow.ts";
import { readBody, withDb, type IdContext } from "../../../../../lib/http.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: IdContext) {
  const [{ id }, body] = await Promise.all([params, readBody(request)]);
  return withDb((db) => financeApprove(db, body.actorId, id));
}
