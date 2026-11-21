import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEMO_TRIP_ID = "T-042";

export function openDatabase(filename = join(process.cwd(), ".data", "agenthon.sqlite")) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS trips (
        id TEXT PRIMARY KEY,
        remaining_budget_cents INTEGER NOT NULL CHECK (remaining_budget_cents >= 0)
      ) STRICT;
    `);
    db.prepare(
      "INSERT INTO trips (id, remaining_budget_cents) VALUES (?, ?) ON CONFLICT (id) DO NOTHING",
    ).run(DEMO_TRIP_ID, 3000);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
