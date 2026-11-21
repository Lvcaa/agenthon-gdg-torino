# Architettura

Stato attuale del prototipo. Aggiorna questo file a ogni modifica di endpoint, tabelle o moduli.

## Stack

Next.js (App Router), TypeScript, SQLite (`node:sqlite`, file `.data/agenthon.sqlite`), policy JSON in `fixtures/`. Il modello è Gemini via REST.

## Endpoint

| Metodo | Percorso | Scopo |
|---|---|---|
| GET | `/` | Pagina con budget residuo di T-042 e clausola taxi della policy. |
| GET | `/api/agent/test` | Test di Gemini. Passa la policy nel contesto e restituisce un JSON `{clauseId, allowed, answer}`. |

## Moduli

| File | Ruolo |
|---|---|
| `lib/db.ts` | Apre SQLite, crea la tabella `trips`, inserisce T-042 con 3000 centesimi. |
| `lib/gemini.ts` | `generateJson(prompt, system)`: chiamata a Gemini con risposta JSON e retry su 503 e 429. |
| `fixtures/policy.json` | Policy versionata (`demo-1`), clausola taxi TR-01. |
| `fixtures/ricevuta-42.json`, `ricevuta-48.json` | Ricevute sintetiche per il collaudo. |

## Dati

Tabella `trips`: `id`, `remaining_budget_cents`. Gli importi sono sempre in centesimi.

## Configurazione

`.env.local` (non versionato, modello in `.env.example`): `GEMINI_GDG_KEY`, `GEMINI_MODEL` (default `gemini-3-flash-preview`).
