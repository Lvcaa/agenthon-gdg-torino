// Scontrino (e fattura, se la categoria la richiede) fittizi per una pratica pagata, da caricare dalla UI.
// I dati vengono dalla pratica: importo e riferimento della transazione, ultime cifre della carta, esercente.
//   node scripts/make-sample-docs.ts [id pratica | latest] [--wrong=amount|card|ref|date|buyer]
// Senza --wrong i documenti combaciano e la pratica viene approvata in automatico.
// Con --wrong un solo dato è sbagliato e la pratica va in revisione Finance.
// I PDF finiscono in data/samples/<id breve>/ (cartella visibile nel Finder, esclusa da git).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { COMPANY_BILLING } from "../lib/categories.ts";
import { openDatabase } from "../lib/db.ts";
import { cardView } from "../lib/flow.ts";

const WRONG = ["amount", "card", "ref", "date", "buyer"] as const;
type Wrong = (typeof WRONG)[number];

const eur = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
const itDate = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");

async function pdf(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 60 + lines.length * 16]);
  const font = await doc.embedFont(StandardFonts.Courier);
  lines.forEach((line, i) => page.drawText(line, { x: 16, y: page.getHeight() - 30 - i * 16, size: 10, font }));
  return doc.save();
}

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--")) ?? "latest";
const wrong = args.find((a) => a.startsWith("--wrong="))?.slice(8) as Wrong | undefined;
if (wrong && !WRONG.includes(wrong)) throw new Error(`--wrong deve essere uno di: ${WRONG.join(", ")}`);

const db = openDatabase();
try {
  const id =
    target === "latest"
      ? (db.prepare("SELECT request_id AS id FROM card_transactions ORDER BY captured_at DESC LIMIT 1").get()?.id as string | undefined)
      : target;
  if (!id) throw new Error("Nessuna pratica pagata con la carta: paga prima dalla UI o passa un id");
  const v = cardView(db, id);
  if (!v.transaction || !v.card?.last4) throw new Error("La pratica non ha ancora un pagamento con carta");

  const t = v.transaction;
  const amount = t.amount_cents + (wrong === "amount" ? 100 : 0);
  const date = wrong === "date" ? "2026-01-02" : t.captured_at;
  const last4 = wrong === "card" ? (v.card.last4 === "0000" ? "1111" : "0000") : v.card.last4;
  const ref = wrong === "ref" ? "ipi_ALTRA0000" : t.id;
  const out = join("data", "samples", id.slice(0, 8));
  mkdirSync(out, { recursive: true });

  const receipt = await pdf([
    t.merchant_name,
    "P.IVA 07654321009",
    `${t.merchant_city ?? "Torino"}`,
    "DOCUMENTO COMMERCIALE",
    `Data ${itDate(date)} ore 14:32`,
    v.rule.label,
    `TOTALE EUR ${eur(amount)}`,
    `Pagamento: carta **** ${last4}`,
    `Rif. transazione ${ref}`,
  ]);
  writeFileSync(join(out, "scontrino.pdf"), receipt);
  const files = ["scontrino.pdf"];

  if (v.rule.requiresInvoice) {
    const buyerVat = wrong === "buyer" ? "IT99999999999" : COMPANY_BILLING.vatNumber;
    const invoice = await pdf([
      t.merchant_name,
      "P.IVA IT07654321009",
      `FATTURA N. ${id.slice(0, 4).toUpperCase()}/2026`,
      `Data ${itDate(date)}`,
      `Cliente: ${wrong === "buyer" ? "Mario Privato" : COMPANY_BILLING.name}`,
      `P.IVA cliente ${buyerVat}`,
      v.rule.label,
      `TOTALE ${eur(amount)} EUR`,
      `Pagato con carta **** ${last4}`,
    ]);
    writeFileSync(join(out, "fattura.pdf"), invoice);
    files.push("fattura.pdf");
  }
  console.log(`Pratica ${id}${wrong ? ` (dato sbagliato: ${wrong})` : ""}:`);
  for (const f of files) console.log(`  ${join(out, f)}`);
} finally {
  db.close();
}
