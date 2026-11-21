import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMPANY_BILLING } from "../../../../../lib/categories.ts";
import { ALLOWED_DOC_MIMES, extractDocument, isCompanyVat, toCents } from "../../../../../lib/document-extract.ts";
import { FlowError, assertCanAttach, attachDocument } from "../../../../../lib/flow.ts";
import { withDbAsync, type IdContext } from "../../../../../lib/http.ts";

export const dynamic = "force-dynamic";

const MAX_DOC_BYTES = 10 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTENSION: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const KIND_LABEL = { receipt: "scontrino/ricevuta", invoice: "fattura" } as const;

// Il dipendente carica uno scontrino o una fattura (multipart: actorId, kind, file). Il modello legge i dati,
// il server calcola l'importo in centesimi e verifica permessi e stato PRIMA di chiamare il modello.
export async function POST(request: Request, { params }: IdContext) {
  const { id } = await params;
  if (Number(request.headers.get("content-length") ?? 0) > MAX_DOC_BYTES + 100_000) {
    return Response.json({ ok: false, error: "File troppo grande (massimo 10 MB)" }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, error: "Richiesta non valida" }, { status: 400 });
  }
  const file = form.get("file");
  const actorId = form.get("actorId");
  const kind = form.get("kind");

  return withDbAsync(async (db) => {
    if (!UUID.test(id)) throw new FlowError(404, "Pratica non trovata");
    assertCanAttach(db, actorId, id, kind);
    if (kind !== "receipt" && kind !== "invoice") throw new FlowError(400, "Tipo di documento non valido");
    if (!(file instanceof File)) throw new FlowError(400, "Manca il file");
    if (!ALLOWED_DOC_MIMES.includes(file.type)) throw new FlowError(415, "Formato non supportato: usa PDF, JPG, PNG o WebP");
    if (file.size === 0 || file.size > MAX_DOC_BYTES) throw new FlowError(413, "Il file deve essere tra 1 byte e 10 MB");
    const bytes = new Uint8Array(await file.arrayBuffer());

    let extracted;
    try {
      extracted = await extractDocument(bytes, file.type);
    } catch (error) {
      console.error(error);
      throw new FlowError(502, "Non sono riuscito a leggere il documento, riprova tra poco");
    }
    if (extracted.documentType !== "unknown" && extracted.documentType !== kind) {
      throw new FlowError(
        422,
        `Hai caricato ${extracted.documentType === "invoice" ? "una fattura" : "uno scontrino/una ricevuta"} ma il campo richiede ${KIND_LABEL[kind]}`,
      );
    }
    const amountCents = toCents(extracted.amountText);
    if (amountCents === null) throw new FlowError(422, "Importo non leggibile, riprova con una foto più nitida");
    const invoicedToCompany = extracted.buyerVatNumber ? isCompanyVat(extracted.buyerVatNumber) : null;
    if (kind === "invoice" && invoicedToCompany === false) {
      // Non si blocca: l'esito «fattura non intestata» manda la pratica in revisione. Il registro lo spiega.
      console.warn(`Fattura non intestata a ${COMPANY_BILLING.name}`);
    }

    const relative = join(".data", "documents", id, `${kind}.${EXTENSION[file.type]}`);
    await mkdir(join(".data", "documents", id), { recursive: true });
    await writeFile(relative, bytes);
    try {
      const updated = attachDocument(db, actorId, id, {
        kind,
        amountCents,
        merchant: extracted.merchant,
        docDate: extracted.docDate,
        vatNumber: extracted.vatNumber,
        invoicedToCompany,
        paymentMethod: extracted.paymentMethod,
        source: "upload",
        filename: file.name.slice(0, 200),
        mime: file.type,
        path: relative,
        extracted,
      });
      return { request: updated, amountCents };
    } catch (error) {
      await rm(relative, { force: true });
      throw error;
    }
  });
}
