import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const CATEGORIES = ["taxi", "train", "meals", "hotel", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Chunk {
  idx: number;
  heading: string;
  page: number;
  text: string;
}

export interface Policy {
  version: string;
  filename: string;
  pages: number;
  text: string;
  chunks: Chunk[];
}

const MAX_CHUNK_CHARS = 1200;
const MAX_EXCERPT_CHARS = 6000;

// ---------- Chunking ----------
// Le sezioni seguono i titoli del documento, così un limite resta nello stesso pezzo del suo titolo e delle
// righe vicine (per esempio una tabella con l'intestazione dei ruoli). Una sezione lunga si divide a righe
// intere e il titolo resta associato a ogni pezzo. Niente finestre di dimensione fissa che tagliano le frasi.

function isHeading(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 90) return false;
  if (/^#{1,4}\s+\S/.test(t)) return true;
  if (/[.:;,]$/.test(t)) return false;
  // Titolo numerato: «1.», «2)», «3.1». Un numero senza punto («30 euro per…») è l'inizio di una riga di testo.
  const numbered = /^(\d+(\.\d+)*[.)]|\d+\.\d+|\p{Lu}[.)])\s+\p{Lu}/u;
  if (numbered.test(t) && t.split(/\s+/).length <= 10) return true;
  const letters = t.replace(/[^\p{L}]/gu, "");
  return letters.length >= 4 && letters === letters.toUpperCase() && t.split(/\s+/).length <= 10;
}

function cleanHeading(line: string): string {
  return line.trim().replace(/^#{1,4}\s+/, "").replace(/[*_`]/g, "").trim();
}

function splitLong(lines: string[]): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const line of lines.flatMap((l) => (l.length > MAX_CHUNK_CHARS ? (l.match(/.{1,1000}(\s|$)/g) ?? [l]) : [l]))) {
    if (current && current.length + line.length + 1 > MAX_CHUNK_CHARS) {
      pieces.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  if (current) pieces.push(current);
  return pieces;
}

export function chunkPolicy(pages: string[]): Omit<Chunk, "idx">[] {
  const sections: { heading: string; page: number; lines: string[] }[] = [];
  let current = { heading: "Premessa", page: 1, lines: [] as string[] };
  pages.forEach((pageText, pageIndex) => {
    for (const raw of pageText.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (isHeading(line)) {
        sections.push(current);
        current = { heading: cleanHeading(line), page: pageIndex + 1, lines: [] };
      } else {
        current.lines.push(line);
      }
    }
  });
  sections.push(current);

  const chunks: Omit<Chunk, "idx">[] = [];
  for (const section of sections) {
    if (section.lines.length === 0) continue;
    const pieces = splitLong(section.lines);
    pieces.forEach((text, i) => {
      chunks.push({
        heading: pieces.length > 1 ? `${section.heading} (${i + 1}/${pieces.length})` : section.heading,
        page: section.page,
        text,
      });
    });
  }
  return chunks;
}

// ---------- Archivio ----------

export function ingestPolicy(
  db: DatabaseSync,
  doc: { filename: string; source: "pdf" | "seed"; pages: string[]; uploadedBy?: string | null },
): Policy {
  const text = doc.pages.join("\n\n");
  const version = createHash("sha256").update(text).digest("hex").slice(0, 8);
  const exists = db.prepare("SELECT 1 AS ok FROM policy_documents WHERE version = ?").get(version);

  db.exec("BEGIN IMMEDIATE");
  try {
    if (!exists) {
      db.prepare(
        "INSERT INTO policy_documents (version, filename, source, pages, text, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(version, doc.filename, doc.source, doc.pages.length, text, doc.uploadedBy ?? null);
      const insert = db.prepare("INSERT INTO policy_chunks (version, idx, heading, page, text) VALUES (?, ?, ?, ?, ?)");
      chunkPolicy(doc.pages).forEach((c, idx) => insert.run(version, idx, c.heading, c.page, c.text));
    }
    db.exec("UPDATE policy_documents SET active = 0 WHERE active = 1");
    db.prepare("UPDATE policy_documents SET active = 1 WHERE version = ?").run(version);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return loadPolicy(db, version);
}

export function loadPolicy(db: DatabaseSync, version: string): Policy {
  const doc = db
    .prepare("SELECT version, filename, pages, text FROM policy_documents WHERE version = ?")
    .get(version) as unknown as Omit<Policy, "chunks"> | undefined;
  if (!doc) throw new Error(`Policy ${version} non trovata`);
  const chunks = db
    .prepare("SELECT idx, heading, page, text FROM policy_chunks WHERE version = ? ORDER BY idx")
    .all(version) as unknown as Chunk[];
  return { ...doc, chunks };
}

// La policy attiva: l'ultima caricata da Finance, oppure quella di esempio.
export function readPolicy(db: DatabaseSync): Policy {
  const active = db.prepare("SELECT version FROM policy_documents WHERE active = 1").get()?.version;
  if (typeof active !== "string") throw new Error("Nessuna policy attiva");
  return loadPolicy(db, active);
}

// Policy di esempio. Se il file cambia e non è stato caricato un PDF, si aggiorna da solo.
export function seedPolicy(db: DatabaseSync) {
  const text = readFileSync(join(process.cwd(), "fixtures", "policy.md"), "utf8");
  const active = db.prepare("SELECT source FROM policy_documents WHERE active = 1").get()?.source;
  if (active === "pdf") return;
  ingestPolicy(db, { filename: "policy.md", source: "seed", pages: [text] });
}

// ---------- Verifica delle citazioni ----------

// Normalizza per il confronto: toglie la formattazione Markdown, riduce gli spazi, ignora le maiuscole.
export function normalize(text: string): string {
  return text.replace(/[*_`>#]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Cerca la citazione nella policy e restituisce il titolo della sezione che la contiene.
export function findSection(policy: Policy, quote: string): string | null {
  const needle = normalize(quote);
  if (needle.length < 10) return null;
  const inChunk = policy.chunks.find((c) => normalize(c.text).includes(needle) || normalize(`${c.heading} ${c.text}`).includes(needle));
  if (inChunk) return `${inChunk.heading} (p. ${inChunk.page})`;
  if (!normalize(policy.text).includes(needle)) return null;
  // Citazione a cavallo di due pezzi: il titolo è quello del pezzo che contiene l'inizio.
  const start = needle.slice(0, 40);
  const first = policy.chunks.find((c) => normalize(c.text).includes(start));
  return first ? `${first.heading} (p. ${first.page})` : "Policy";
}

// ---------- Ricerca degli estratti pertinenti ----------
// BM25 sui pezzi: nessun servizio esterno, risultato ripetibile. Il modello riceve l'indice dei titoli e
// solo gli estratti più rilevanti, non l'intero documento.

const STOPWORDS = new Set(
  "il lo la i gli le un uno una di a da in con su per tra fra e ed o ma che non si è sono ho ha al del della dei delle dal nel nella sul sulla mi ti ci vi come anche se più quanto cosa posso può devo voglio euro eur".split(" "),
);

const SYNONYMS: [RegExp, string][] = [
  [/taxi|auto con conducente|\bncc\b/i, "taxi trasporti locali"],
  [/treno|ferrovi|frecc|italo|biglietto/i, "treno ferrovia"],
  [/pasto|pasti|cibo|ristorant|pranzo|cena|colazione|mangiare/i, "pasti vitto cibo"],
  [/hotel|albergo|pernott|dormire|alloggi|notte/i, "hotel pernottamento alloggio"],
  [/parcheggi|bagagli|material|cancelleria|altre spese/i, "altre spese"],
  [/deroga|supera|oltre il (limite|budget)|sforare/i, "deroghe deroga"],
];

function tokenize(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map((t) => (t.length > 6 ? t.slice(0, 6) : t));
}

export function retrieve(policy: Policy, query: string, k: number): Chunk[] {
  const queryTokens = [...new Set(tokenize(expandQuery(query)))];
  const docs = policy.chunks.map((c) => tokenize(`${c.heading} ${c.heading} ${c.text}`));
  const n = docs.length;
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, n);
  const docFrequency = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) docFrequency.set(t, (docFrequency.get(t) ?? 0) + 1);

  const scored = docs.map((tokens, i) => {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const q of queryTokens) {
      const f = tf.get(q) ?? 0;
      if (!f) continue;
      const df = docFrequency.get(q) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * tokens.length) / avgLength));
    }
    return { chunk: policy.chunks[i], score };
  });

  const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.chunk.idx - b.chunk.idx);
  const picked = (hits.length ? hits : scored).slice(0, k).map((s) => s.chunk);
  return picked.sort((a, b) => a.idx - b.idx);
}

export function expandQuery(query: string): string {
  return [query, ...SYNONYMS.filter(([pattern]) => pattern.test(query)).map(([, words]) => words)].join(" ");
}

// Indice dei titoli: poche righe che dicono al modello cosa contiene il documento.
export function policyIndex(policy: Policy, maxEntries = 60): string {
  const entries = policy.chunks.slice(0, maxEntries).map((c) => `- S${c.idx} · p. ${c.page} · ${c.heading}`);
  const more = policy.chunks.length > maxEntries ? `\n- … altre ${policy.chunks.length - maxEntries} sezioni` : "";
  return entries.join("\n") + more;
}

export function excerpts(chunks: Chunk[], maxChars = MAX_EXCERPT_CHARS): string {
  const parts: string[] = [];
  let used = 0;
  for (const c of chunks) {
    const part = `[S${c.idx} · p. ${c.page} · ${c.heading}]\n${c.text}`;
    if (used + part.length > maxChars && parts.length > 0) break;
    parts.push(part);
    used += part.length;
  }
  return parts.join("\n\n");
}
