import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEMO_TRIP_ID, openDatabase } from "../lib/db.ts";

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
