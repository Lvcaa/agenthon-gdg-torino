# AGENTHON · Team Gatti

Prototipo per la traccia B. L’app verifica policy e budget di una trasferta, gestisce le deroghe e porta una ricevuta fino al CSV autorizzato da Finance, con un registro delle decisioni.

- [CLAUDE.md](CLAUDE.md) — istruzioni operative per gli agenti.
- [Piano hackathon](docs/piano-hackathon.md) — requisiti della traccia, sviluppo, collaudo e copione della demo.

## Avvio locale

Serve Node.js 24 o successivo. SQLite è incluso in Node. Il primo accesso crea `.data/agenthon.sqlite` con la trasferta sintetica T-042 e 30 € di budget residuo.

```sh
npm ci
npm run dev
```

Apri <http://127.0.0.1:3000>. Per verificare la base esegui `npm test`, `npm run typecheck` e `npm run build`.

La pagina iniziale ha i link alle tre schermate. Aprile in tre finestre: **Dipendente** (chat), **Manager** (chat con le richieste) e **Finance** (caricamento della policy in PDF più chat con coda e CSV). Serve `GEMINI_GDG_KEY` in `.env.local`. Finché Finance non carica un PDF (testo selezionabile, niente scansioni) vale la policy di esempio in [fixtures/policy.md](fixtures/policy.md). Il pulsante **Reset demo** riporta lo scenario ai 30 € residui. Dettagli in [architettura](docs/architecture.md) e [schema DB](docs/schema-db.md).

Per provare il caricamento c'è [policy-demo.pdf](policy-demo.pdf), generato dalla policy di esempio. Si rigenera con `npm run policy:pdf`.
