import { extractText, getDocumentProxy } from "unpdf";

// Testo per pagina di un PDF con testo selezionabile. I PDF scansionati (solo immagini) non sono supportati.
export async function extractPdfPages(bytes: Uint8Array): Promise<string[]> {
  // pdf.js prende possesso del buffer: gli passiamo una copia, così il chiamante può ancora salvare il file.
  const pdf = await getDocumentProxy(bytes.slice());
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}
