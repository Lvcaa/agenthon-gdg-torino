import { confirmProposal } from "../../../../lib/flow.ts";
import { issueIfPending, readBody, withDbAsync } from "../../../../lib/http.ts";

export const dynamic = "force-dynamic";

// Il dipendente conferma la proposta dell'agente. Il client manda l'id del messaggio e, se chiede una deroga,
// la motivazione (`justification`, obbligatoria oltre il budget: 400 se manca).
// Se la pratica nasce già autorizzata, la carta virtuale si genera subito dopo il commit.
export async function POST(request: Request) {
  const body = await readBody(request);
  return withDbAsync(async (db) => {
    const result = confirmProposal(db, body.actorId, body.messageId, body.justification);
    await issueIfPending(db, result.request.id);
    return result;
  });
}
