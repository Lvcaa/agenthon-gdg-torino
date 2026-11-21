import { resetDemo } from "../../../../lib/flow.ts";
import { withDb } from "../../../../lib/http.ts";

export const dynamic = "force-dynamic";

// Solo per la demo: riporta lo scenario ai 30 € residui.
export async function POST() {
  return withDb((db) => {
    resetDemo(db);
    return {};
  });
}
