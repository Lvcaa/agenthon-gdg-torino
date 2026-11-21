import { MAX_PDF_BYTES, uploadPolicyPdf } from "../../../lib/policy-upload.ts";
import { errorResponse, withDbAsync } from "../../../lib/http.ts";

export const dynamic = "force-dynamic";

// Solo Finance. multipart/form-data con `actorId` e `file` (PDF).
export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_PDF_BYTES + 10_000) {
    return Response.json({ ok: false, error: "File troppo grande" }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, error: "Richiesta non valida" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ ok: false, error: "Manca il file" }, { status: 400 });
  try {
    return await withDbAsync(async (db) => {
      const policy = await uploadPolicyPdf(db, form.get("actorId"), { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      return { version: policy.version, pages: policy.pages, sections: policy.chunks.length };
    });
  } catch (error) {
    return errorResponse(error);
  }
}
