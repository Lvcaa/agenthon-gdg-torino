import { openDatabase } from "../../../../lib/db.ts";
import { deactivateCapturedCard, recordCardTransaction } from "../../../../lib/flow.ts";
import { errorResponse, sandboxStripe } from "../../../../lib/http.ts";
import { transactionFromStripe, verifyWebhook } from "../../../../lib/stripe.ts";

export const dynamic = "force-dynamic";

// Webhook Stripe (facoltativo in sandbox: `stripe listen --forward-to localhost:3000/api/stripe/webhook`).
// Legge il corpo grezzo, verifica la firma, registra la transazione e disattiva la carta. Idempotente.
export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return Response.json({ ok: false, error: "STRIPE_WEBHOOK_SECRET non configurato" }, { status: 503 });
  const payload = await request.text();
  let event: { type?: string; data?: { object?: unknown } };
  try {
    event = verifyWebhook(payload, request.headers.get("stripe-signature"), secret) as typeof event;
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Firma non valida" }, { status: 400 });
  }
  if (event.type !== "issuing_transaction.created") return Response.json({ ok: true, ignored: true });

  const db = openDatabase();
  try {
    const result = recordCardTransaction(db, transactionFromStripe(event.data?.object));
    if (result.recorded && !result.duplicate) {
      const stripe = sandboxStripe();
      if (stripe) await deactivateCapturedCard(db, stripe, result.stripeCardId, result.requestId);
    }
    return Response.json({ ok: true, recorded: result.recorded, duplicate: result.duplicate });
  } catch (error) {
    return errorResponse(error);
  } finally {
    db.close();
  }
}
