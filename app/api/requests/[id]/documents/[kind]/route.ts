import { readFile } from "node:fs/promises";
import { openDatabase } from "../../../../../../lib/db.ts";
import { errorResponse } from "../../../../../../lib/http.ts";
import { buildDocumentSummaryPdf, buildTransactionPdf } from "../../../../../../lib/ticket-pdf.ts";
import { documentDownload } from "../../../../../../lib/views.ts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; kind: string }> };

const pdf = (bytes: Uint8Array, filename: string) =>
  new Response(Buffer.from(bytes), {
    headers: { "content-type": "application/pdf", "content-disposition": `inline; filename=${filename}`, "cache-control": "no-store" },
  });

// Solo Finance: scontrino, fattura (originale o riepilogo dei dati estratti) o ricevuta di transazione.
export async function GET(request: Request, { params }: Context) {
  const { id, kind } = await params;
  const actorId = new URL(request.url).searchParams.get("actorId");
  try {
    const download = (() => {
      const db = openDatabase();
      try {
        return documentDownload(db, actorId, id, kind);
      } finally {
        db.close();
      }
    })();
    const short = id.slice(0, 8);
    if (download.type === "transaction") return pdf(await buildTransactionPdf(download.transaction, download.card), `transazione-${short}.pdf`);
    if (download.type === "summary") return pdf(await buildDocumentSummaryPdf(download.document), `${kind}-${short}.pdf`);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(download.path);
    } catch {
      // File sparito dal disco: si scaricano almeno i dati estratti.
      return pdf(await buildDocumentSummaryPdf(download.fallback), `${kind}-${short}.pdf`);
    }
    return new Response(Buffer.from(bytes), {
      headers: {
        "content-type": download.mime,
        "content-disposition": `inline; filename=${download.filename}`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
