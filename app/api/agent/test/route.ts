import policy from "../../../../fixtures/policy.json";
import { generateJson } from "../../../../lib/gemini";

export const dynamic = "force-dynamic";

// Test: l'agente legge la policy passata nel contesto e risponde con JSON semplice.
export async function GET() {
  try {
    const result = await generateJson(
      "Domanda del dipendente: posso prendere un taxi in trasferta?",
      `Sei l'assistente rimborsi. Rispondi solo con JSON {"clauseId": string, "allowed": boolean, "answer": string}. Policy:\n${JSON.stringify(policy)}`,
    );
    return Response.json({ ok: true, policyVersion: policy.version, result });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
