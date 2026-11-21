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
          <div className="panel-head">
            <h2>Policy aziendale</h2>
            <p className="muted small">È il testo che l&apos;assistente cita in ogni risposta.</p>
          </div>
          <PolicyUpload actorId={actorId} />
          <div className="policy-info">
            <div>
              <strong>{policy.filename}</strong>
              <div className="muted small">
                versione {policy.version} · {policy.pages} {policy.pages === 1 ? "pagina" : "pagine"} · {policy.chunks.length} sezioni
              </div>
            </div>
            <span className="tag status-done" style={{ marginLeft: "auto" }}>
              Attiva
            </span>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
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
