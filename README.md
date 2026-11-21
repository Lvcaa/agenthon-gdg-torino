# AGENTHON · Team Gatti

Prototipo per la traccia B. L’app verifica policy e budget di una trasferta, gestisce le deroghe e porta una ricevuta fino al CSV autorizzato da Finance, con un registro delle decisioni.

- [CLAUDE.md](CLAUDE.md) — istruzioni operative per gli agenti.
- [Piano hackathon](docs/piano-hackathon.md) — requisiti della traccia, sviluppo, collaudo e copione della demo.

## Avvio locale

Serve Node.js 24 o successivo. SQLite è incluso in Node. Il primo accesso crea `data/agenthon.sqlite` con la trasferta sintetica T-042 e 30 € di budget residuo.

```sh
npm ci
npm run dev
```

Apri <http://127.0.0.1:3000>. Per verificare la base esegui `npm test`, `npm run typecheck` e `npm run build`.

La pagina iniziale ha i link alle tre schermate. Aprile in tre finestre: **Dipendente** (chat), **Manager** (chat con le richieste) e **Finance** (caricamento della policy in PDF più chat con coda e CSV). Serve `GEMINI_GDG_KEY` in `.env.local`. Finché Finance non carica un PDF (testo selezionabile, niente scansioni) vale la policy di esempio in [fixtures/policy.md](fixtures/policy.md). A sinistra della chat ogni ruolo ha la sua sezione: il dipendente **Le mie richieste** (in corso con i documenti mancanti, completate), il manager le richieste **in attesa** (filtro per urgenza), **approvate** e **rifiutate**, Finance le **Note spese** con ricerca per persona e download di scontrino, transazione e fattura. Cosa manca è in [TODO.md](TODO.md). Il pulsante **Reset demo** riporta lo scenario ai 30 € residui. Dettagli in [architettura](docs/architecture.md) e [schema DB](docs/schema-db.md).

## Carta virtuale (sandbox)

Il provider si sceglie con `CARD_PROVIDER` in `.env.local`:

- `simulator` (predefinito): nessun account, nessuna rete. Applica tetto, categoria e monouso come una carta vera. Stato in `data/card-simulator.json`.
- `lithic` (consigliato per la demo): sandbox gratuita su lithic.com, nessuna verifica aziendale. Copia la sandbox API key in `LITHIC_API_KEY`. Carta `SINGLE_USE` con tetto pari all'autorizzato; il pagamento oltre il tetto lo rifiuta Lithic. Valuta USD in sandbox.
- `stripe`: Stripe Issuing in sandbox (`STRIPE_SECRET_KEY` `sk_test_…`, `STRIPE_REGION=us`). Richiede Issuing attivo e la verifica aziendale, e non è disponibile per account con sede in Italia. Saldo di test: `node --env-file=.env.local scripts/stripe-setup.ts`. Webhook facoltativo: `stripe listen --forward-to localhost:3000/api/stripe/webhook` e segreto in `STRIPE_WEBHOOK_SECRET`.

Percorso: il dipendente conferma la richiesta, il manager approva (o la richiesta rientra nel residuo), compare la carta virtuale. Con **Paga con la carta (sandbox)** si simula il pagamento, poi si caricano lo scontrino (sempre) e la fattura intestata all'azienda (hotel, noleggio, carburante, congressi, altre spese), letti con Gemini. Il server confronta scontrino, fattura e transazione: se tutto combacia il rimborso è approvato in automatico, altrimenti la pratica va in revisione e Finance la controlla e la approva a mano (una ricevuta oltre l'autorizzato resta ferma). Finance apre il **Ticket PDF** e scarica il CSV. Se la deroga è rifiutata non si genera nessuna carta: il dipendente paga con la sua fino al residuo e viene rimborsato a fine mese. Se il provider non è configurato vale lo stesso percorso con carta personale.

Per provare il caricamento dei documenti, dopo il pagamento con la carta genera uno scontrino (e la fattura, se serve) coerente con l'ultima pratica pagata: `npm run docs:sample`. Con `npm run docs:sample -- <id> --wrong=amount` (oppure `card`, `ref`, `date`, `buyer`) un solo dato è sbagliato e la pratica va in revisione. I PDF finiscono in `data/samples/` (visibile nel Finder, esclusa da git).

Per provare il caricamento della policy c'è [policy-demo.pdf](policy-demo.pdf), generato dalla policy di esempio. Si rigenera con `npm run policy:pdf`.
