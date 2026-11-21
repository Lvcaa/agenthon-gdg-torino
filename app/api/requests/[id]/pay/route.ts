import { FlowError, payWithCard } from "../../../../../lib/flow.ts";
import { readBody, sandboxStripe, withDbAsync, type IdContext } from "../../../../../lib/http.ts";

export const dynamic = "force-dynamic";

// Solo sandbox: simula il pagamento del dipendente con la carta virtuale. `amountCents` è facoltativo (default = autorizzato).
export async function POST(request: Request, { params }: IdContext) {
  const [{ id }, body] = await Promise.all([params, readBody(request)]);
  const amount = body.amountCents;
  return withDbAsync(async (db) => {
    if (amount !== undefined && amount !== null && (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0)) {
      throw new FlowError(400, "L'importo deve essere un intero positivo in centesimi");
    }
    return payWithCard(db, sandboxStripe(), body.actorId, id, typeof amount === "number" ? amount : undefined);
  });
}
