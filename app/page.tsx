import { DEMO_TRIP_ID } from "../lib/db";
import { ResetButton } from "./components";

const SCREENS = [
  { href: "/employee", title: "Dipendente", text: "Chiede all'assistente se una spesa rientra nella policy e invia la richiesta." },
  { href: "/manager", title: "Manager", text: "Riceve le richieste con priorità e citazione della policy, e decide." },
  { href: "/finance", title: "Finance", text: "Carica la policy in PDF, approva i rimborsi e scarica il CSV." },
];

export default function Home() {
  return (
    <main className="narrow">
      <header>
        <div>
          <h1>Assistente rimborsi</h1>
          <div className="muted">Trasferta {DEMO_TRIP_ID} · dati sintetici</div>
        </div>
        <ResetButton />
      </header>
      <p>Apri una finestra per ruolo, una accanto all'altra. Ogni schermata è una chat separata.</p>
      <div className="cards">
        {SCREENS.map((s) => (
          <a key={s.href} href={s.href} className="card link">
            <strong>{s.title}</strong>
            <div className="muted">{s.text}</div>
          </a>
        ))}
      </div>
    </main>
  );
}
