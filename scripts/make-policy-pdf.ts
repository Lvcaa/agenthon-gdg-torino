// Genera policy-demo.pdf dal testo di fixtures/policy.md. Uso: npm run policy:pdf
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makePdf } from "../test/helpers/pdf.ts";

const LINE_WIDTH = 88;
const LINES_PER_PAGE = 28;

function wrap(text: string): string[] {
  if (!text) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (current && current.length + word.length + 1 > LINE_WIDTH) {
      lines.push(current);
      current = word;
    } else {
      current += (current ? " " : "") + word;
    }
  }
  lines.push(current);
  return lines;
}

const source = readFileSync(join(process.cwd(), "fixtures", "policy.md"), "utf8");
const lines = source
  .split(/\r?\n/)
  .map((line) => line.replace(/^#{1,4}\s+/, "").replace(/[*_`]/g, ""))
  .flatMap(wrap);

const pages: string[][] = [];
for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));

const target = join(process.cwd(), "policy-demo.pdf");
writeFileSync(target, makePdf(pages));
console.log(`${target}: ${pages.length} pagine, ${lines.length} righe`);
