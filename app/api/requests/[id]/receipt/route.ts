import { attachReceipt } from "../../../../../lib/flow.ts";
import { readBody, withDb, type IdContext } from "../../../../../lib/http.ts";

export const dynamic = "force-dynamic";

// Carica una ricevuta sintetica costruita sulla pratica: `kind` è "exact" (pari all'autorizzato) o "over".
export async function POST(request: Request, { params }: IdContext) {
  const [{ id }, body] = await Promise.all([params, readBody(request)]);
  return withDb((db) => ({ request: attachReceipt(db, body.actorId, id, body.kind) }));
}
