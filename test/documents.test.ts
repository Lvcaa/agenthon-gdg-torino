import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { COMPANY_BILLING } from "../lib/categories.ts";
import { extractDocument, isCompanyVat, toCents } from "../lib/document-extract.ts";
import { buildTicketPdf, type TicketData } from "../lib/ticket-pdf.ts";
import { makePdf } from "./helpers/pdf.ts";

// PNG 1x1 rosso
const PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"),
);

test("toCents accetta formati validi", () => {
  for (const [t, c] of [["42,00", 4200], ["42.00", 4200], ["€ 42", 4200], ["1.234,50", 123450], ["1,234.50", 123450], ["0,5", 50], ["12.5", 1250]] as const) {
    assert.equal(toCents(t), c, t);
  }
});

test("toCents rifiuta valori ambigui o non validi", () => {
  for (const t of ["1.234", "1,234", "-5", "0", "0,00", "42,001", "abc", "", "1.2.3,4", "12,3,4", null]) {
    assert.equal(toCents(t as string | null), null, String(t));
  }
});

test("isCompanyVat normalizza spazi e prefisso", () => {
  assert.ok(isCompanyVat("IT01234567897"));
  assert.ok(isCompanyVat("01234567897"));
  assert.ok(isCompanyVat(" it 0123 4567 897 "));
  assert.ok(!isCompanyVat("IT99999999999"));
  assert.ok(!isCompanyVat(null));
  assert.ok(!isCompanyVat(""));
});

test("extractDocument valida e normalizza", async () => {
  const llm = async () => ({ documentType: "Fattura", amountText: "42,00", merchant: "Taxi", docDate: "2026-05-01", vatNumber: "IT123", buyerVatNumber: null, paymentMethod: "Contanti" });
  const r = await extractDocument(new Uint8Array([1]), "application/pdf", llm);
  assert.equal(r.documentType, "invoice");
  assert.equal(r.paymentMethod, "cash");
  assert.equal(r.amountText, "42,00");
  assert.equal(toCents(r.amountText), 4200);
  await assert.rejects(() => extractDocument(new Uint8Array([1]), "application/pdf", async () => "ciao"));
  await assert.rejects(() => extractDocument(new Uint8Array([1]), "application/pdf", async () => ({ merchant: { a: 1 } })));
  await assert.rejects(() => extractDocument(new Uint8Array([1]), "text/plain", llm));
});

const base: TicketData = {
  request: { id: "r1", category: "taxi", categoryLabel: "Taxi e NCC", requestedCents: 4200, residualCents: 3000, extraCents: 1200, authorizedCents: 4200, status: "pending_finance", funding: "card", reason: "Cliente “importante” – città", policyQuote: "Il taxi è € 30", policyVersion: "v1" },
  employee: { id: "u1", name: "Anna Rossi" },
  decisions: [{ kind: "exception", decision: "approved", by: "Marco", channel: "web", at: "2026-05-01T10:00:00Z" }],
  requirements: { receiptLabel: "Ricevuta del tassista", requiresInvoice: false, invoiceNote: "" },
  card: { last4: "4242", limitCents: 4200, allowedCategories: ["taxicabs_limousines"] },
  transaction: { id: "ipi_1", merchantName: "TAXI TORINO", merchantCategory: "taxicabs_limousines", merchantCity: "Torino", amountCents: 4200, capturedAt: "2026-05-01T11:00:00Z" },
  documents: [
    { kind: "receipt", amountCents: 4200, merchant: "Taxi", docDate: "2026-05-01", vatNumber: null, invoicedToCompany: null, paymentMethod: "card", source: "upload", path: "a.pdf", mime: "application/pdf" },
    { kind: "invoice", amountCents: 4200, merchant: "Taxi", docDate: null, vatNumber: null, invoicedToCompany: true, paymentMethod: "card", source: "upload", path: "b.png", mime: "image/png" },
  ],
  verification: { outcome: "match", receiptCents: 4200, reimbursedCents: null },
  company: { ...COMPANY_BILLING },
};

test("buildTicketPdf con carta, transazione, PDF e PNG", async () => {
  const files: Record<string, Uint8Array> = { "a.pdf": makePdf([["uno"], ["due"]]), "b.png": PNG };
  const out = await buildTicketPdf(base, async (p) => files[p]);
  const pdf = await PDFDocument.load(out);
  // riepilogo + transazione + 2 pagine PDF + 1 immagine
  assert.equal(pdf.getPageCount(), 5);
});

test("buildTicketPdf personale senza transazione, con documento sintetico e testo lungo", async () => {
  const d: TicketData = {
    ...base,
    request: { ...base.request, funding: "personal", reason: "x".repeat(400) + " ŝ 漢字" },
    card: null,
    transaction: null,
    documents: [{ ...base.documents[0], source: "synthetic", path: null, mime: null }],
  };
  const out = await buildTicketPdf(d, async () => { throw new Error("no"); });
  const pdf = await PDFDocument.load(out);
  assert.equal(pdf.getPageCount(), 2);
});
