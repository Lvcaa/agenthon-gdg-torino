import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCardSimulator } from "../lib/card-simulator.ts";

function sim(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "card-sim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return () => createCardSimulator(join(dir, "state.json"));
}

const pay = (cardId: string, amountCents: number, key: string, merchantCategory = "taxicabs_limousines") => ({
  cardId, amountCents, merchantName: "TAXI TORINO", merchantCategory, merchantCity: "Torino", idempotencyKey: key,
});

test("simulator: one card per request, state survives a new instance", async (t) => {
  const make = sim(t);
  const a = await make().createCard({ requestId: "R1", cardholderId: "ich", limitCents: 4200, allowedCategories: ["taxicabs_limousines"] });
  const b = await make().createCard({ requestId: "R1", cardholderId: "ich", limitCents: 4200, allowedCategories: ["taxicabs_limousines"] });
  assert.equal(a.id, b.id);
  assert.equal(a.status, "active");
});

test("simulator: enforces limit, category, active card and idempotency", async (t) => {
  const make = sim(t);
  const card = await make().createCard({ requestId: "R2", cardholderId: "ich", limitCents: 4200, allowedCategories: ["taxicabs_limousines"] });
  const over = await make().simulatePayment(pay(card.id, 4201, "k-over"));
  assert.equal(over.approved, false);
  assert.equal(!over.approved && over.reason, "spending_controls");
  const wrong = await make().simulatePayment(pay(card.id, 1000, "k-cat", "eating_places_restaurants"));
  assert.equal(!wrong.approved && wrong.reason, "merchant_category_not_allowed");
  const ok = await make().simulatePayment(pay(card.id, 4200, "k-ok"));
  assert.ok(ok.approved && ok.transaction.amountCents === 4200);
  const again = await make().simulatePayment(pay(card.id, 4200, "k-ok"));
  assert.deepEqual(again, ok);
  await make().deactivateCard(card.id);
  const after = await make().simulatePayment(pay(card.id, 100, "k-after"));
  assert.equal(!after.approved && after.reason, "card_inactive");
});
