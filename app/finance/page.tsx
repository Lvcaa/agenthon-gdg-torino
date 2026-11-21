import { openDatabase } from "../../lib/db";
import { readPolicy } from "../../lib/policy";
import { ChatScreen } from "../chat-screen";
import { PolicyUpload } from "../components";

export const dynamic = "force-dynamic";

// Schermata Finance: a sinistra la policy attiva e il caricamento del PDF, a destra la chat con la coda.
export default async function FinancePage({ searchParams }: { searchParams: Promise<{ as?: string }> }) {
  const { as } = await searchParams;
  const db = openDatabase();
  let policy;
  let actorId: string;
  try {
    policy = readPolicy(db);
    const finance = db.prepare("SELECT id FROM roles_and_users WHERE permission = 'finance' ORDER BY name").all();
    actorId = (finance.find((u) => u.id === as) ?? finance[0]).id as string;
  } finally {
    db.close();
  }

  return (
    <ChatScreen
      permission="finance"
      as={as}
      aside={
        <section className="panel">
          <h2>Policy aziendale</h2>
          <PolicyUpload actorId={actorId} />
          <div className="policy-info">
            <strong>{policy.filename}</strong>
            <div className="muted">
              versione {policy.version} · {policy.pages} {policy.pages === 1 ? "pagina" : "pagine"} · {policy.chunks.length} sezioni
            </div>
          </div>
          <p className="muted small">
            Controlla che le sezioni qui sotto siano quelle del documento: l'assistente legge solo i pezzi pertinenti a ogni domanda.
          </p>
          <ol className="sections">
            {policy.chunks.map((c) => (
              <li key={c.idx}>
                {c.heading} <span className="muted">p. {c.page}</span>
              </li>
            ))}
          </ol>
        </section>
      }
    />
  );
}
