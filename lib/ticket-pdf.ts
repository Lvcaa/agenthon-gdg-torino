import { readFile as fsReadFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export interface TicketData {
  request: {
    id: string;
    category: string;
    categoryLabel: string;
    requestedCents: number;
    residualCents: number;
    extraCents: number;
    authorizedCents: number | null;
    status: string;
    funding: "card" | "personal" | null;
    reason: string | null;
    policyQuote: string | null;
    policyVersion: string | null;
  };
  employee: { id: string; name: string; email?: string | null };
  decisions: { kind: string; decision: string; by: string; channel: string | null; at: string }[];
  requirements: { receiptLabel: string; requiresInvoice: boolean; invoiceNote: string };
  card: { last4: string; limitCents: number; allowedCategories: string[] } | null;
  transaction: {
    id: string;
    merchantName: string;
    merchantCategory: string;
    merchantCity: string | null;
    amountCents: number;
    capturedAt: string;
  } | null;
  documents: {
    kind: "receipt" | "invoice";
    amountCents: number | null;
    merchant: string | null;
    docDate: string | null;
    vatNumber: string | null;
    invoicedToCompany: boolean | null;
    paymentMethod: "card" | "cash" | "unknown" | null;
    source: "upload" | "synthetic";
    path: string | null;
    mime: string | null;
  }[];
  verification: { outcome: string; receiptCents: number | null; reimbursedCents: number | null } | null;
  company: { name: string; vatNumber: string; sdiCode: string; pec: string; address: string };
}

export type ReadFile = (path: string) => Promise<Uint8Array>;

const eur = (c: number | null | undefined) => (c == null ? "-" : `${(c / 100).toFixed(2).replace(".", ",")} EUR`);

// Helvetica usa WinAnsi: sostituisce ciò che non è codificabile invece di crashare.
function safe(text: string, font: PDFFont): string {
  const map: Record<string, string> = { "€": "EUR", "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "...", " ": " " };
  let out = "";
  for (const ch of text.replace(/[\r\t]/g, " ")) {
    const c = map[ch] ?? ch;
    if (c === "\n") { out += c; continue; }
    try {
      font.encodeText(c);
      out += c;
    } catch {
      out += "?";
    }
  }
  return out;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 50;

class Writer {
  page!: PDFPage;
  y = 0;
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  constructor(doc: PDFDocument, font: PDFFont, bold: PDFFont) {
    this.doc = doc;
    this.font = font;
    this.bold = bold;
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage(A4);
    this.y = A4[1] - MARGIN;
  }
  wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];
    for (const para of safe(text, font).split("\n")) {
      let cur = "";
      for (let word of para.split(" ")) {
        while (font.widthOfTextAtSize(word, size) > width) {
          let n = word.length;
          while (n > 1 && font.widthOfTextAtSize(word.slice(0, n), size) > width) n--;
          if (cur) { lines.push(cur); cur = ""; }
          lines.push(word.slice(0, n));
          word = word.slice(n);
        }
        const next = cur ? `${cur} ${word}` : word;
        if (cur && font.widthOfTextAtSize(next, size) > width) { lines.push(cur); cur = word; } else cur = next;
      }
      lines.push(cur);
    }
    return lines;
  }
  text(text: string, opts: { size?: number; bold?: boolean; indent?: number; gap?: number } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.font;
    const indent = opts.indent ?? 0;
    for (const line of this.wrap(text, font, size, A4[0] - 2 * MARGIN - indent)) {
      if (this.y < MARGIN + size) this.newPage();
      this.page.drawText(line, { x: MARGIN + indent, y: this.y - size, size, font, color: rgb(0.1, 0.1, 0.1) });
      this.y -= size * 1.4;
    }
    this.y -= opts.gap ?? 0;
  }
  kv(label: string, value: string) {
    this.text(`${label}: ${value}`, { indent: 8 });
  }
}

async function embedImage(doc: PDFDocument, bytes: Uint8Array, mime: string) {
  const img = mime === "image/png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const page = doc.addPage(A4);
  const maxW = A4[0] - 2 * MARGIN;
  const maxH = A4[1] - 2 * MARGIN;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawImage(img, { x: (A4[0] - w) / 2, y: A4[1] - MARGIN - h, width: w, height: h });
}

export async function buildTicketPdf(data: TicketData, readFile: ReadFile = fsReadFile): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Ticket di spesa ${data.request.id}`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, font, bold);
  const r = data.request;

  w.text("Ticket di spesa", { size: 20, bold: true, gap: 4 });
  w.text(`${data.company.name} - P.IVA ${data.company.vatNumber}`, { gap: 10 });

  w.text("Pratica", { size: 13, bold: true });
  w.kv("Id", r.id);
  w.kv("Dipendente", data.employee.name + (data.employee.email ? ` <${data.employee.email}>` : ""));
  w.kv("Categoria", `${r.categoryLabel} (${r.category})`);
  w.kv("Importo richiesto", eur(r.requestedCents));
  w.kv("Residuo", eur(r.residualCents));
  w.kv("Extra (deroga)", eur(r.extraCents));
  w.kv("Autorizzato", eur(r.authorizedCents));
  w.kv("Stato", r.status);
  w.kv("Pagamento", r.funding === "card" ? "carta virtuale monouso" : r.funding === "personal" ? "carta personale con rimborso" : "non specificato");
  if (r.reason) w.kv("Motivazione", r.reason);
  if (r.policyQuote) w.kv("Policy", `"${r.policyQuote}"${r.policyVersion ? ` (versione ${r.policyVersion})` : ""}`);
  w.y -= 6;

  w.text("Decisioni", { size: 13, bold: true });
  if (!data.decisions.length) w.text("Nessuna decisione registrata.", { indent: 8 });
  for (const d of data.decisions) w.text(`${d.at} - ${d.kind}: ${d.decision} (${d.by}${d.channel ? `, ${d.channel}` : ""})`, { indent: 8 });
  w.y -= 6;

  w.text("Documenti richiesti", { size: 13, bold: true });
  w.kv("Scontrino/ricevuta", data.requirements.receiptLabel);
  w.kv("Fattura intestata all'azienda", data.requirements.requiresInvoice ? `richiesta (${data.requirements.invoiceNote})` : "non richiesta");
  for (const d of data.documents) {
    w.text(
      `${d.kind === "invoice" ? "Fattura" : "Scontrino/ricevuta"}: ${eur(d.amountCents)}, ${d.merchant ?? "esercente n/d"}, ${d.docDate ?? "data n/d"}` +
        `${d.vatNumber ? `, P.IVA ${d.vatNumber}` : ""}${d.invoicedToCompany === true ? ", intestata all'azienda" : d.invoicedToCompany === false ? ", NON intestata all'azienda" : ""}` +
        `, origine ${d.source === "upload" ? "caricata" : "sintetica"}`,
      { indent: 8 },
    );
  }
  w.y -= 6;

  w.text("Esito verifica", { size: 13, bold: true });
  if (data.verification) {
    w.kv("Esito", data.verification.outcome);
    w.kv("Importo documento", eur(data.verification.receiptCents));
    w.kv("Rimborso", data.verification.reimbursedCents == null ? "-" : eur(data.verification.reimbursedCents));
  } else w.text("Verifica non ancora eseguita.", { indent: 8 });
  if (data.card) w.kv("Carta", `**** ${data.card.last4}, limite ${eur(data.card.limitCents)}`);

  if (data.transaction) {
    const t = data.transaction;
    const tw = new Writer(doc, font, bold);
    tw.text("Ricevuta di transazione Stripe (sandbox)", { size: 18, bold: true, gap: 6 });
    tw.text("Questa ricevuta proviene dall'ambiente di prova Stripe: non ha valore fiscale.", { gap: 8 });
    tw.kv("Transazione", t.id);
    tw.kv("Esercente", t.merchantName);
    tw.kv("Categoria esercente", t.merchantCategory);
    if (t.merchantCity) tw.kv("Citta", t.merchantCity);
    tw.kv("Importo", eur(t.amountCents));
    tw.kv("Data e ora", t.capturedAt);
    if (data.card) {
      tw.kv("Carta", `**** ${data.card.last4}`);
      tw.kv("Limite carta", eur(data.card.limitCents));
      tw.kv("Categorie consentite", data.card.allowedCategories.join(", ") || "nessuna restrizione");
    }
  }

  for (const d of data.documents) {
    const title = d.kind === "invoice" ? "Fattura" : "Scontrino/ricevuta";
    let embedded = false;
    if (d.source === "upload" && d.path && (d.mime === "application/pdf" || d.mime === "image/jpeg" || d.mime === "image/png")) {
      try {
        const bytes = await readFile(d.path);
        if (d.mime === "application/pdf") {
          const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
          const pages = await doc.copyPages(src, src.getPageIndices());
          pages.forEach((p) => doc.addPage(p));
        } else await embedImage(doc, bytes, d.mime);
        embedded = true;
      } catch {
        embedded = false;
      }
    }
    if (!embedded) {
      const sw = new Writer(doc, font, bold);
      sw.text(`${title}: documento sintetico o non incorporabile`, { size: 16, bold: true, gap: 6 });
      sw.text("L'originale non è incorporato in questo PDF (documento sintetico, formato non supportato o file non leggibile). Dati estratti:", { gap: 6 });
      sw.kv("Importo", eur(d.amountCents));
      sw.kv("Esercente", d.merchant ?? "-");
      sw.kv("Data", d.docDate ?? "-");
      sw.kv("P.IVA esercente", d.vatNumber ?? "-");
      sw.kv("Intestata all'azienda", d.invoicedToCompany == null ? "-" : d.invoicedToCompany ? "si" : "no");
      sw.kv("Metodo di pagamento", d.paymentMethod ?? "-");
      sw.kv("Origine", d.source);
      if (d.path) sw.kv("File", d.path);
    }
  }

  return doc.save();
}
