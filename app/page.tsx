import policy from "../fixtures/policy.json";
import { DEMO_TRIP_ID, openDatabase } from "../lib/db";

export const dynamic = "force-dynamic";

export default function Home() {
  const db = openDatabase();
  let budget: number;
  try {
    const trip = db.prepare("SELECT remaining_budget_cents FROM trips WHERE id = ?").get(DEMO_TRIP_ID);
    if (typeof trip?.remaining_budget_cents !== "number") {
      throw new Error("Budget demo non disponibile");
    }
    budget = trip.remaining_budget_cents;
  } finally {
    db.close();
  }

  const remainingBudget = new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
  }).format(budget / 100);

  return (
    <main>
      <h1>Rimborsi di trasferta</h1>
      <h2>Trasferta demo {DEMO_TRIP_ID}</h2>
      <p>Budget residuo: {remainingBudget}</p>
      <p>Policy {policy.version} · {policy.taxi.id} · {policy.taxi.text}</p>
    </main>
  );
}
