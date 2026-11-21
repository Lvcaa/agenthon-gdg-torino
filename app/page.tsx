import { DEMO_TRIP_ID } from "../lib/db";
import { ResetButton } from "./components";
import { IconArrow, IconChart, IconShield, IconUser, Logo } from "./icons";

const SCREENS = [
  {
    href: "/employee",
    title: "Dipendente",
    icon: <IconUser size={18} />,
    pain: "I soldi della trasferta smettono di uscire dal tuo conto.",
    text: "Chiedi in chat prima di spendere. Se la spesa rientra è già autorizzata, se sfora la richiesta al manager la prepara l'assistente.",
    cta: "Apri come dipendente",
  },
  {
    href: "/manager",
    title: "Manager",
    icon: <IconShield size={18} />,
    pain: "Ti arrivano solo le spese fuori policy.",
    text: "Il resto si autorizza da solo. Per ogni deroga vedi importo, motivo e clausola della policy, e decidi con un clic.",
    cta: "Apri come manager",
  },
  {
    href: "/finance",
    title: "Finance",
    icon: <IconChart size={18} />,
    pain: "Le note spese da ricontrollare spariscono.",
    text: "Ogni spesa arriva abbinata a richiesta e ricevuta. Se la ricevuta supera l'importo autorizzato la pratica si ferma, altrimenti approvi e scarichi il CSV.",
    cta: "Apri come Finance",
  },
];

export default function Home() {
  return (
    <main className="home">
      <nav className="home-nav">
        <span className="brand">
          <Logo size={30} />
          <span className="wordmark">Ask<i>&amp;</i>Card</span>
        </span>
        <ResetButton />
      </nav>

      <section className="hero">
        <div>
          <h1>
            Smetti di <mark>rincorrere i rimborsi.</mark>
          </h1>
          <p className="lede">
            Prima di prenotare o pagare, il dipendente chiede in chat se la spesa rientra. Se è dentro la policy è già autorizzata e la paga
            con la carta della trasferta. Se sfora, il manager riceve importo e motivo e decide. A fine mese Finance trova ogni spesa
            già abbinata alla sua ricevuta.
          </p>
          <div className="hero-cta">
            <a className="btn primary" href="/employee">
              Prova la chat di Anna <IconArrow size={16} />
            </a>
            <a className="btn" href="/manager">
              Apri la coda di Giulia
            </a>
          </div>
        </div>

        <div className="hero-visual">
        <div className="frame" aria-label="Anteprima della chat del dipendente">
          <div className="frame-bar">
            <i />
            <i />
            <i />
            <span style={{ marginLeft: 8 }}>Anna Rossi · trasferta {DEMO_TRIP_ID}</span>
          </div>
          <div className="frame-body">
            <div className="q">Devo prenotare l&apos;hotel per la fiera di Milano, costa 130 €. Rientra nel mio budget?</div>
            <p className="a">Il tuo budget hotel da junior è 100 € per trasferta. Per 130 € servono 30 € di deroga: preparo la richiesta per il manager.</p>
            <div className="doc">
              <div className="doc-head">
                <div className="title">
                  <strong>Hotel</strong>
                  <span>Proposta da confermare</span>
                </div>
                <div className="right">
                  <span className="tag p3">Alta</span>
                  <span className="amount">130,00 €</span>
                </div>
              </div>
              <dl className="ledger">
                <div>
                  <dt>Limite policy</dt>
                  <dd>100,00 €</dd>
                </div>
                <div>
                  <dt>Budget residuo</dt>
                  <dd>100,00 €</dd>
                </div>
                <div className="key">
                  <dt>Deroga richiesta</dt>
                  <dd>30,00 €</dd>
                </div>
              </dl>
            </div>
            <p className="approved">Approvata da Giulia Verdi · carta abilitata</p>
          </div>
        </div>
        <div className="vcard" aria-label="Carta virtuale della trasferta">
          <div className="vcard-top">
            <span className="wordmark">
              Ask<i>&amp;</i>Card
            </span>
            <span>Trasferta {DEMO_TRIP_ID}</span>
          </div>
          <span className="vcard-chip" aria-hidden="true" />
          <div className="vcard-num">•••• •••• •••• 4821</div>
          <div className="vcard-bottom">
            <span>
              Anna Rossi
              <small>Disponibile</small>
            </span>
            <strong>130,00 €</strong>
          </div>
        </div>
        </div>
      </section>

      <section className="roles">
        <h2>Cosa cambia per chi la usa. Per la demo apri le tre viste in finestre affiancate.</h2>
        {SCREENS.map((s) => (
          <a key={s.href} href={s.href} className="role">
            <strong>
              {s.icon}
              {s.title}
            </strong>
            <div>
              <p className="pain">{s.pain}</p>
              <p>{s.text}</p>
            </div>
            <span className="go">
              {s.cta} <IconArrow size={15} />
            </span>
          </a>
        ))}
      </section>

      <footer className="home-foot">Ask&amp;Card · prototipo Agenthon · dati sintetici · trasferta {DEMO_TRIP_ID}</footer>
    </main>
  );
}
