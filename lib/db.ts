import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXPENSE_CATEGORIES } from "./categories.ts";
import { seedPolicy } from "./policy.ts";

export const DEMO_TRIP_ID = "T-042";

// Posizioni (seniority). I limiti di spesa non sono nel database: li legge l'agente dalla policy.
export const DEMO_ROLES = [
  { role: "junior", description: "Livello di ingresso" },
  { role: "senior", description: "Livello intermedio" },
  { role: "lead", description: "Responsabile di team" },
  { role: "director", description: "Direzione" },
] as const;

// Utenti sintetici con UUID fissi, così il reset riporta sempre lo stesso scenario.
export const DEMO_USERS = [
  { id: "8d5b40b8-4224-4cae-97e3-f4577d61a039", name: "Anna Rossi", role: "junior", permission: "employee" },
  { id: "95363f10-772e-4966-8156-89610b39bcc1", name: "Marco Bianchi", role: "senior", permission: "employee" },
  { id: "c98c4b9e-7dfa-4ea0-901b-669fcb9a683d", name: "Giulia Verdi", role: "lead", permission: "manager" },
  { id: "c97d1983-8b36-4605-a655-78d525a76540", name: "Paolo Neri", role: "senior", permission: "finance" },
] as const;

const SCHEMA = `
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    remaining_budget_cents INTEGER NOT NULL CHECK (remaining_budget_cents >= 0)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS roles (
    role TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT ''
  ) STRICT;

  -- permission è il permesso nel flusso (chi può inviare, approvare, esportare). role è la seniority.
  CREATE TABLE IF NOT EXISTS roles_and_users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL REFERENCES roles (role),
    permission TEXT NOT NULL CHECK (permission IN ('employee', 'manager', 'finance')),
    telegram_chat_id TEXT UNIQUE,
    stripe_cardholder_id TEXT
  ) STRICT;

  -- Regole documentali e categorie Stripe per ogni categoria di spesa (seed da lib/categories.ts).
  CREATE TABLE IF NOT EXISTS expense_categories (
    code TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    stripe_categories TEXT NOT NULL DEFAULT '[]',
    mcc TEXT NOT NULL DEFAULT '',
    requires_invoice INTEGER NOT NULL CHECK (requires_invoice IN (0, 1)),
    receipt_label TEXT NOT NULL,
    invoice_note TEXT NOT NULL DEFAULT ''
  ) STRICT;

  -- Codici monouso per collegare una chat Telegram a un utente. Il ruolo viene sempre dal database.
  CREATE TABLE IF NOT EXISTS telegram_link_codes (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES roles_and_users (id),
    expires_at TEXT NOT NULL,
    used_at TEXT
  ) STRICT;

  -- Policy aziendale: il documento caricato da Finance (o quella di esempio) e i suoi pezzi consultabili.
  CREATE TABLE IF NOT EXISTS policy_documents (
    version TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('pdf', 'seed')),
    pages INTEGER NOT NULL CHECK (pages > 0),
    text TEXT NOT NULL,
    uploaded_by TEXT REFERENCES roles_and_users (id),
    uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS policy_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL REFERENCES policy_documents (version),
    idx INTEGER NOT NULL,
    heading TEXT NOT NULL,
    page INTEGER NOT NULL,
    text TEXT NOT NULL,
    UNIQUE (version, idx)
  ) STRICT;

  -- Conversazione: l'unica interfaccia. card è un JSON con l'elemento da mostrare sotto il messaggio.
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES roles_and_users (id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    card TEXT,
    request_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips (id),
    user_id TEXT NOT NULL REFERENCES roles_and_users (id),
    category TEXT NOT NULL CHECK (category IN ('taxi', 'train', 'meals', 'hotel', 'other')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    budget_cents INTEGER NOT NULL CHECK (budget_cents >= 0),
    extra_cents INTEGER NOT NULL CHECK (extra_cents >= 0),
    authorized_cents INTEGER CHECK (authorized_cents >= 0),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
      'draft', 'pending_manager', 'approved', 'rejected',
      'in_review', 'pending_finance', 'finance_approved', 'exported'
    )),
    priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 4),
    priority_rule TEXT NOT NULL,
    urgency TEXT NOT NULL DEFAULT 'later' CHECK (urgency IN ('immediate', 'day', 'week', 'later')),
    clause_quote TEXT,
    policy_gap INTEGER NOT NULL DEFAULT 0 CHECK (policy_gap IN (0, 1)),
    policy_version TEXT NOT NULL,
    clause_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    funding TEXT CHECK (funding IN ('card', 'personal')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT;

  -- UNIQUE (request_id, kind): una doppia approvazione lascia una sola decisione.
  CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL REFERENCES requests (id),
    kind TEXT NOT NULL CHECK (kind IN ('manager', 'manager_supplement', 'finance')),
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
    -- decided_by vuoto solo per le decisioni automatiche dell'agente di verifica (channel = 'agent').
    decided_by TEXT REFERENCES roles_and_users (id),
    channel TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'telegram', 'agent')),
    amount_cents INTEGER CHECK (amount_cents >= 0),
    decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (request_id, kind)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS receipts (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE REFERENCES requests (id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    outcome TEXT NOT NULL CHECK (outcome IN ('match', 'over_authorized', 'capped', 'mismatch')),
    raw_json TEXT NOT NULL,
    verified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    reimbursed_cents INTEGER CHECK (reimbursed_cents >= 0)
  ) STRICT;

  -- Carta virtuale monouso, una per pratica. pending = autorizzata ma non ancora creata su Stripe.
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE REFERENCES requests (id),
    stripe_card_id TEXT UNIQUE,
    last4 TEXT,
    exp_month INTEGER,
    exp_year INTEGER,
    limit_cents INTEGER NOT NULL CHECK (limit_cents > 0),
    allowed_categories TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'inactive', 'failed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT;

  -- Pagamenti catturati. L'id è quello Stripe: la stessa transazione registrata due volte resta una riga.
  CREATE TABLE IF NOT EXISTS card_transactions (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES requests (id),
    stripe_card_id TEXT NOT NULL,
    authorization_id TEXT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    merchant_name TEXT NOT NULL,
    merchant_category TEXT NOT NULL,
    merchant_city TEXT,
    captured_at TEXT NOT NULL,
    raw_json TEXT NOT NULL
  ) STRICT;

  -- Scontrino (receipt) obbligatorio, fattura (invoice) in più per le categorie che la richiedono.
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES requests (id),
    kind TEXT NOT NULL CHECK (kind IN ('receipt', 'invoice')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    merchant TEXT,
    doc_date TEXT,
    vat_number TEXT,
    invoiced_to_company INTEGER CHECK (invoiced_to_company IN (0, 1)),
    payment_method TEXT NOT NULL DEFAULT 'unknown' CHECK (payment_method IN ('card', 'cash', 'unknown')),
    card_last4 TEXT,
    transaction_ref TEXT,
    source TEXT NOT NULL CHECK (source IN ('upload', 'synthetic')),
    filename TEXT,
    mime TEXT,
    path TEXT,
    extracted_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (request_id, kind)
  ) STRICT;

  -- Registro: append-only, un evento per ogni passaggio della pratica.
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT REFERENCES requests (id),
    actor_id TEXT REFERENCES roles_and_users (id),
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status, priority DESC, created_at);
  CREATE INDEX IF NOT EXISTS idx_events_request ON events (request_id, id);
`;

function seed(db: DatabaseSync) {
  db.prepare(
    "INSERT INTO trips (id, remaining_budget_cents) VALUES (?, ?) ON CONFLICT (id) DO NOTHING",
  ).run(DEMO_TRIP_ID, 3000);

  const upsertRole = db.prepare(
    "INSERT INTO roles (role, description) VALUES (?, ?) ON CONFLICT (role) DO UPDATE SET description = excluded.description",
  );
  for (const { role, description } of DEMO_ROLES) upsertRole.run(role, description);

  seedPolicy(db);

  const upsertCategory = db.prepare(
    `INSERT INTO expense_categories (code, label, stripe_categories, mcc, requires_invoice, receipt_label, invoice_note)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (code) DO UPDATE SET label = excluded.label, stripe_categories = excluded.stripe_categories,
       mcc = excluded.mcc, requires_invoice = excluded.requires_invoice, receipt_label = excluded.receipt_label,
       invoice_note = excluded.invoice_note`,
  );
  for (const c of EXPENSE_CATEGORIES) {
    upsertCategory.run(c.code, c.label, JSON.stringify(c.stripeCategories), c.mcc, c.requiresInvoice ? 1 : 0, c.receiptLabel, c.invoiceNote);
  }

  const insertUser = db.prepare(
    "INSERT INTO roles_and_users (id, name, role, permission) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
  );
  for (const user of DEMO_USERS) {
    insertUser.run(user.id, user.name, user.role, user.permission);
  }
}

// Database creati con una versione precedente dello schema.
function migrate(db: DatabaseSync) {
  const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name));

  const requestColumns = columns("requests");
  if (!requestColumns.includes("urgency")) {
    db.exec(
      "ALTER TABLE requests ADD COLUMN urgency TEXT NOT NULL DEFAULT 'later' CHECK (urgency IN ('immediate', 'day', 'week', 'later'))",
    );
  }
  if (!requestColumns.includes("clause_quote")) db.exec("ALTER TABLE requests ADD COLUMN clause_quote TEXT");
  if (!requestColumns.includes("policy_gap")) {
    db.exec("ALTER TABLE requests ADD COLUMN policy_gap INTEGER NOT NULL DEFAULT 0 CHECK (policy_gap IN (0, 1))");
  }

  // I budget per categoria erano nella tabella roles. Ora li legge l'agente dalla policy.
  const roleColumns = columns("roles");
  for (const column of roleColumns.filter((c) => c.endsWith("_cents"))) db.exec(`ALTER TABLE roles DROP COLUMN ${column}`);
  if (!roleColumns.includes("description")) db.exec("ALTER TABLE roles ADD COLUMN description TEXT NOT NULL DEFAULT ''");

  // Carta Stripe: funding della pratica e cardholder dell'utente.
  if (!requestColumns.includes("funding")) {
    db.exec("ALTER TABLE requests ADD COLUMN funding TEXT CHECK (funding IN ('card', 'personal'))");
  }
  if (!columns("roles_and_users").includes("stripe_cardholder_id")) {
    db.exec("ALTER TABLE roles_and_users ADD COLUMN stripe_cardholder_id TEXT");
  }

  // La cartella dei dati era .data (nascosta nel Finder): i percorsi salvati puntano ora a data/.
  db.exec("UPDATE documents SET path = 'data/' || substr(path, 7) WHERE path LIKE '.data/%'");

  // documents: ultime cifre della carta e riferimento della transazione stampati sul documento.
  const documentColumns = columns("documents");
  if (!documentColumns.includes("card_last4")) db.exec("ALTER TABLE documents ADD COLUMN card_last4 TEXT");
  if (!documentColumns.includes("transaction_ref")) db.exec("ALTER TABLE documents ADD COLUMN transaction_ref TEXT");

  // approvals: canale 'agent' e decided_by facoltativo per l'approvazione automatica. Si ricostruisce la tabella.
  const approvalSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get()?.sql ?? "");
  if (approvalSql && !approvalSql.includes("'agent'")) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`
      ALTER TABLE approvals RENAME TO approvals_old;
      CREATE TABLE approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL REFERENCES requests (id),
        kind TEXT NOT NULL CHECK (kind IN ('manager', 'manager_supplement', 'finance')),
        decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
        decided_by TEXT REFERENCES roles_and_users (id),
        channel TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'telegram', 'agent')),
        amount_cents INTEGER CHECK (amount_cents >= 0),
        decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (request_id, kind)
      ) STRICT;
      INSERT INTO approvals SELECT * FROM approvals_old;
      DROP TABLE approvals_old;
    `);
    db.exec("PRAGMA foreign_keys = ON");
  }

  // receipts: nuovi esiti (capped, mismatch) e rimborso. Il CHECK non si altera, quindi si ricostruisce la tabella.
  const receiptSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'receipts'").get()?.sql ?? "");
  if (receiptSql && (!receiptSql.includes("'capped'") || !columns("receipts").includes("reimbursed_cents"))) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`
      ALTER TABLE receipts RENAME TO receipts_old;
      CREATE TABLE receipts (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE REFERENCES requests (id),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        outcome TEXT NOT NULL CHECK (outcome IN ('match', 'over_authorized', 'capped', 'mismatch')),
        raw_json TEXT NOT NULL,
        verified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        reimbursed_cents INTEGER CHECK (reimbursed_cents >= 0)
      ) STRICT;
      INSERT INTO receipts (id, request_id, amount_cents, outcome, raw_json, verified_at, reimbursed_cents)
        SELECT id, request_id, amount_cents, outcome, raw_json, verified_at,
               CASE WHEN outcome = 'match' THEN amount_cents END FROM receipts_old;
      DROP TABLE receipts_old;
    `);
    db.exec("PRAGMA foreign_keys = ON");
  }
}

export function openDatabase(filename = join(process.cwd(), "data", "agenthon.sqlite")) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec(SCHEMA);
    migrate(db);
    seed(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
