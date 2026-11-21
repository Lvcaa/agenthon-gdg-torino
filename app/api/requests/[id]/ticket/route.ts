import { ticketData } from "../../../../../lib/flow.ts";
import { errorResponse, type IdContext } from "../../../../../lib/http.ts";
import { openDatabase } from "../../../../../lib/db.ts";
import { buildTicketPdf } from "../../../../../lib/ticket-pdf.ts";

export const dynamic = "force-dynamic";

// Ticket PDF per Finance: riepilogo, ricevuta di transazione e originali dei documenti.
export async function GET(request: Request, { params }: IdContext) {
  const { id } = await params;
  const actorId = new URL(request.url).searchParams.get("actorId");
  try {
    const data = (() => {
      const db = openDatabase();
      try {
        return ticketData(db, actorId, id);
      } finally {
        db.close();
      }
    })();
    const pdf = await buildTicketPdf(data);
    return new Response(Buffer.from(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename=ticket-${id}.pdf`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
