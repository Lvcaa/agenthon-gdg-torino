import { agentTurn } from "../../../lib/agent.ts";
import { readBody, withDbAsync } from "../../../lib/http.ts";

export const dynamic = "force-dynamic";

// Un messaggio dell'utente. L'agente risponde e il server verifica la proposta prima di salvarla.
export async function POST(request: Request) {
  const body = await readBody(request);
  return withDbAsync(async (db) => {
    await agentTurn(db, body.actorId, body.message);
    return {};
  });
}
