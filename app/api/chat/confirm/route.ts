import { confirmProposal } from "../../../../lib/flow.ts";
import { readBody, withDb } from "../../../../lib/http.ts";

export const dynamic = "force-dynamic";

// Il dipendente conferma la proposta dell'agente. Il client manda solo l'id del messaggio.
export async function POST(request: Request) {
  const body = await readBody(request);
  return withDb((db) => confirmProposal(db, body.actorId, body.messageId));
}
