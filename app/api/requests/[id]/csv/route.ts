import { exportCsv } from "../../../../../lib/flow.ts";
import { withDb, type IdContext } from "../../../../../lib/http.ts";

export const dynamic = "force-dynamic";

// Export CSV: il server lo blocca finché Finance non ha approvato.
export async function GET(request: Request, { params }: IdContext) {
  const { id } = await params;
  const actorId = new URL(request.url).searchParams.get("actorId");
  return withDb((db) => {
    const { filename, csv } = exportCsv(db, actorId, id);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  });
}
