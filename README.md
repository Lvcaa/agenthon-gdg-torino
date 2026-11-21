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
