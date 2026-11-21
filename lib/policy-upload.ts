import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { addMessage, FlowError, getActor } from "./flow.ts";
import { extractPdfPages } from "./pdf.ts";
import { ingestPolicy, type Policy } from "./policy.ts";

export const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const MIN_TEXT_CHARS = 200;

function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "policy.pdf";
  return base.replace(/[^\w.\- ]/g, "_").slice(0, 80) || "policy.pdf";
}

// Solo Finance carica la policy. Il server controlla tipo, dimensione e presenza di testo selezionabile.
export async function uploadPolicyPdf(
  db: DatabaseSync,
  actorId: unknown,
  file: { name: string; bytes: Uint8Array },
  directory = join(process.cwd(), ".data", "policies"),
): Promise<Policy> {
  const actor = getActor(db, actorId, "finance");
  if (file.bytes.length === 0 || file.bytes.length > MAX_PDF_BYTES) {
    throw new FlowError(413, `Il PDF deve essere tra 1 byte e ${MAX_PDF_BYTES / 1024 / 1024} MB`);
  }
  if (new TextDecoder().decode(file.bytes.slice(0, 5)) !== "%PDF-") throw new FlowError(415, "Il file non è un PDF");

  let pages: string[];
  try {
    pages = await extractPdfPages(file.bytes);
  } catch {
    throw new FlowError(422, "Non riesco a leggere il PDF");
  }
  if (pages.length > MAX_PDF_PAGES) throw new FlowError(413, `Massimo ${MAX_PDF_PAGES} pagine`);
  if (pages.join("").replace(/\s/g, "").length < MIN_TEXT_CHARS) {
    throw new FlowError(422, "Il PDF non contiene testo selezionabile: i file scansionati non sono supportati");
  }

  const filename = safeName(file.name);
  const policy = ingestPolicy(db, { filename, source: "pdf", pages, uploadedBy: actor.id });
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${policy.version}.pdf`), file.bytes);

  db.prepare("INSERT INTO events (request_id, actor_id, type, payload) VALUES (NULL, ?, 'policy_uploaded', ?)").run(
    actor.id,
    JSON.stringify({ version: policy.version, filename, pages: policy.pages, sections: policy.chunks.length }),
  );
  addMessage(
    db,
    actor.id,
    "assistant",
    `Policy caricata: ${policy.pages} pagine, ${policy.chunks.length} sezioni, versione ${policy.version}. Controlla che le sezioni siano quelle giuste. Le richieste in attesa mantengono la versione con cui sono state preparate.`,
    { type: "policy", version: policy.version },
  );
  return policy;
}
