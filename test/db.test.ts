import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DEMO_TRIP_ID, DEMO_USERS, openDatabase } from "../lib/db.ts";

test("SQLite seeds the demo trip and preserves changes across restarts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agenthon-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "test.sqlite");

  {
    using db = openDatabase(filename);
    const trip = db.prepare("SELECT remaining_budget_cents FROM trips WHERE id = ?").get(DEMO_TRIP_ID);
    assert.equal(trip?.remaining_budget_cents, 3000);
    db.prepare("UPDATE trips SET remaining_budget_cents = ? WHERE id = ?").run(1800, DEMO_TRIP_ID);
  }

  {
    using db = openDatabase(filename);
    const trip = db.prepare("SELECT remaining_budget_cents FROM trips WHERE id = ?").get(DEMO_TRIP_ID);
    assert.equal(trip?.remaining_budget_cents, 1800);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM trips").get()?.count, 1);
  }
});

test("roles and demo users are seeded", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agenthon-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  using db = openDatabase(join(directory, "test.sqlite"));

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM roles").get()?.count, 4);
  assert.deepEqual(
    db.prepare("PRAGMA table_info(roles)").all().map((c) => c.name),
    ["role", "description"],
  );

  const permissions = db
    .prepare("SELECT permission FROM roles_and_users ORDER BY permission")
    .all()
    .map((row) => row.permission);
  assert.deepEqual(permissions, ["employee", "employee", "finance", "manager"]);

  assert.throws(() =>
    db
      .prepare("INSERT INTO roles_and_users (id, name, role, permission) VALUES ('x', 'X', 'ghost', 'employee')")
      .run(),
  );
});

test("a database from the table-budget schema is migrated", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agenthon-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "old.sqlite");

  {
    const old = new DatabaseSync(filename);
    old.exec(`
      CREATE TABLE roles (role TEXT PRIMARY KEY, taxi_cents INTEGER NOT NULL CHECK (taxi_cents >= 0)) STRICT;
      INSERT INTO roles (role, taxi_cents) VALUES ('junior', 3000);
      CREATE TABLE trips (id TEXT PRIMARY KEY, remaining_budget_cents INTEGER NOT NULL) STRICT;
      CREATE TABLE roles_and_users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL REFERENCES roles (role),
        permission TEXT NOT NULL, telegram_chat_id TEXT UNIQUE) STRICT;
      CREATE TABLE requests (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, user_id TEXT NOT NULL, category TEXT NOT NULL,
        amount_cents INTEGER NOT NULL, budget_cents INTEGER NOT NULL, extra_cents INTEGER NOT NULL, authorized_cents INTEGER,
        status TEXT NOT NULL DEFAULT 'draft', priority INTEGER NOT NULL, priority_rule TEXT NOT NULL,
        policy_version TEXT NOT NULL, clause_id TEXT NOT NULL, reason TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '') STRICT;
    `);
    old.close();
  }

  using db = openDatabase(filename);
  assert.deepEqual(
    db.prepare("PRAGMA table_info(roles)").all().map((c) => c.name),
    ["role", "description"],
  );
  const columns = db.prepare("PRAGMA table_info(requests)").all().map((c) => c.name);
  for (const column of ["urgency", "clause_quote", "policy_gap"]) assert.ok(columns.includes(column), column);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM roles").get()?.count, 4);
});

test("a second decision of the same kind on a request is rejected", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agenthon-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  using db = openDatabase(join(directory, "test.sqlite"));

  db.prepare(
    `INSERT INTO requests (id, trip_id, user_id, category, amount_cents, budget_cents, extra_cents,
       priority, priority_rule, policy_version, clause_id, reason)
     VALUES ('r1', ?, ?, 'taxi', 4200, 3000, 1200, 4, 'immediate', 'demo-1', 'TR-01', 'test')`,
  ).run(DEMO_TRIP_ID, DEMO_USERS[0].id);

  const approve = () =>
    db
      .prepare("INSERT INTO approvals (request_id, kind, decision, decided_by) VALUES ('r1', 'manager', 'approved', ?)")
      .run(DEMO_USERS[2].id);
  approve();
  assert.throws(approve);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM approvals").get()?.count, 1);
});

test("a telegram chat can be linked to one user only", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agenthon-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  using db = openDatabase(join(directory, "test.sqlite"));

  db.prepare("INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES ('ABC123', ?, '2999-01-01T00:00:00Z')").run(
    DEMO_USERS[0].id,
  );
  const link = (userId: string) =>
    db.prepare("UPDATE roles_and_users SET telegram_chat_id = '555' WHERE id = ?").run(userId);
  link(DEMO_USERS[0].id);
  assert.throws(() => link(DEMO_USERS[2].id));
});
