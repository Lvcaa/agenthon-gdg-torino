# Architettura

Stato attuale del prototipo. Aggiorna questo file a ogni modifica di endpoint, tabelle o moduli.

## Stack

Next.js (App Router), TypeScript, SQLite (`node:sqlite`, file `.data/agenthon.sqlite`), policy in testo libero in `fixtures/policy.md`. Il modello è Gemini via REST.

## Endpoint

| Metodo | Percorso | Scopo |
|---|---|---|
| GET | `/` | Pagina iniziale con i link alle tre schermate. |
| GET | `/employee` | Chat del dipendente. `?as=<uuid>` sceglie tra i dipendenti (Anna, Marco). |
| GET | `/manager` | Chat del manager, con le richieste da approvare. |
| GET | `/finance` | A sinistra la policy attiva (sezioni trovate) e il caricamento del PDF, a destra la chat di Finance con coda, rimborso e CSV. |

Ogni schermata è una conversazione separata, aggiornata ogni 3 secondi: si aprono in tre finestre affiancate.
| POST | `/api/chat` | `{actorId, message}`. Un turno con l'agente: il modello risponde, il server verifica l'eventuale proposta e salva i messaggi. Non crea pratiche. |
| POST | `/api/policy` | Solo Finance. `multipart/form-data` con `actorId` e `file` (PDF, massimo 5 MB e 100 pagine, testo selezionabile). Estrae il testo, lo divide in sezioni, lo rende la policy attiva e salva l'originale in `.data/policies/<versione>.pdf`. |
| POST | `/api/chat/confirm` | `{actorId, messageId}`. Il dipendente conferma la proposta: il server la rilegge dalla chat, la riverifica sulla policy e crea la pratica. Se nasce autorizzata, genera la carta virtuale. |
| POST | `/api/requests/[id]/decision` | Il manager approva o rifiuta (`decision`). Un secondo identico non crea una seconda decisione. Canale sempre `web`. Se approva, genera la carta virtuale; se rifiuta con residuo, apre il percorso con carta personale. |
| POST | `/api/requests/[id]/receipt` | Il dipendente carica una ricevuta sintetica costruita sulla pratica (`kind`: `exact`, pari all'autorizzato, oppure `over`, +6 €). |
| POST | `/api/requests/[id]/finance` | Finance approva il rimborso. |
| GET | `/api/requests/[id]/csv?actorId=` | CSV della pratica. Bloccato (409) finché Finance non ha approvato. |
| POST | `/api/requests/[id]/pay` | Solo sandbox. `{actorId, amountCents?}` (intero positivo, default = autorizzato). Il proprietario simula il pagamento con la carta virtuale attiva. Stripe lo rifiuta se supera il tetto. |
| POST | `/api/requests/[id]/documents` | `multipart/form-data` con `actorId`, `kind` (`receipt`, `invoice`) e `file` (PDF, JPG, PNG, WebP, massimo 10 MB). Permessi e stato si controllano prima di chiamare il modello (`assertCanAttach`). Il modello legge il documento, il server calcola l'importo (422 se illeggibile o se il tipo contraddice `kind`) e salva il file in `.data/documents/<pratica>/<kind>.<ext>`. |
| GET | `/api/requests/[id]/ticket?actorId=` | Solo Finance, dopo la verifica dei documenti. PDF (`application/pdf`, inline) con riepilogo, ricevuta di transazione e originali. |
| POST | `/api/stripe/webhook` | Firma `Stripe-Signature` verificata con `STRIPE_WEBHOOK_SECRET` (503 se manca, 400 se non valida). `issuing_transaction.created` registra la transazione e disattiva la carta; gli altri eventi sono ignorati con 200. Idempotente. Facoltativo: il pagamento simulato registra già la transazione. |
| POST | `/api/demo/reset` | Riporta lo scenario ai 30 € residui e svuota le chat. Solo demo. |

Il codice di collegamento Telegram si genera dalla chat («collega Telegram»).

## Moduli

| File | Ruolo |
|---|---|
| `lib/db.ts` | Apre SQLite, crea lo schema, migra i database vecchi, inserisce T-042, posizioni e utenti demo (`DEMO_USERS`, UUID fissi). |
| `lib/policy.ts` | Policy a pezzi: `chunkPolicy` (sezioni per titolo), `ingestPolicy`/`readPolicy` (archivio e policy attiva), `retrieve` (BM25), `policyIndex` e `excerpts` (cosa vede il modello), `findSection` (titolo e pagina di una citazione). Versione = impronta del testo. `seedPolicy` carica `fixtures/policy.md` se non c'è un PDF attivo. |
| `lib/pdf.ts`, `lib/policy-upload.ts` | Estrazione del testo con `unpdf` e caricamento riservato a Finance: controlla tipo, dimensione, pagine e presenza di testo, poi registra evento e messaggio in chat. |
| `lib/proposal.ts` | `verifyProposal`: controlla la proposta dell'agente (citazione presente nella policy, limite scritto nella citazione, importi in centesimi interi). |
| `lib/agent.ts` | `agentTurn`: prompt con policy, profilo e stato, chiamata al modello, verifica con un nuovo tentativo, scelta della scheda da mostrare. Il modello è iniettabile per i test. |
| `lib/flow.ts` | Pratica e registro: conferma della proposta, decisione manager, ricevuta, approvazione Finance, CSV, codice Telegram, reset, notifiche in chat. Ogni funzione verifica permesso e stato. Errori come `FlowError` con codice HTTP. |
| `lib/card-provider.ts` | `cardProviderFromEnv`: sceglie il provider delle carte virtuali con `CARD_PROVIDER` (`simulator`, `lithic`, `stripe`), tutti con l'interfaccia `StripeIssuing`. Le route e `lib/http.ts` usano solo questa funzione, mai `stripeFromEnv` direttamente. Predefinito `simulator`. |
| `lib/card-simulator.ts` | Emittente simulato senza rete (tetto `all_time`, categorie ammesse, carta attiva, idempotenza), stato in `.data/card-simulator.json`. |
| `lib/lithic.ts` | Provider Lithic sandbox (`https://sandbox.lithic.com`, mai produzione): carta `SINGLE_USE` con `spend_limit`, regola MCC per carta (con controllo anche lato client), pagamento simulato con `simulate/authorize` e `simulate/clearing`. La transazione compare in modo asincrono: la lettura riprova sul 404. Valuta USD. |
| `lib/stripe.ts` | Client REST di Stripe Issuing (niente SDK): `stripeFromEnv` (null senza chiave, errore se non `sk_test_`), titolare e carta virtuale (idempotency key `card-<pratica>`), disattivazione, pagamento di prova (Test Helpers), `verifyWebhook` (HMAC con tolleranza) e `transactionFromStripe`. |
| `lib/categories.ts` | Categorie di spesa (categorie Stripe, MCC, fattura richiesta, etichetta della ricevuta) e dati di fatturazione aziendali sintetici `COMPANY_BILLING`. |
| `lib/document-extract.ts` | `extractDocument`: Gemini legge scontrino o fattura (immagine o PDF) e restituisce testo dell'importo, esercente, data, P.IVA venditore e acquirente. `toCents` converte l'importo in centesimi e rifiuta i valori ambigui, `isCompanyVat` confronta l'acquirente con l'azienda. |
| `lib/ticket-pdf.ts` | `buildTicketPdf` (pdf-lib): ticket per Finance con riepilogo, ricevuta di transazione e originali accodati. |
| `lib/gemini.ts` | `generateJson(prompt, system)`: chiamata a Gemini con risposta JSON, temperatura 0.2 e retry su 503 e 429. |
| `lib/http.ts`, `lib/format.ts` | Helper dei route handler e formattazione degli importi. |
| `app/chat-screen.tsx`, `app/components.tsx` | Schermata a chat condivisa (server: messaggi e schede dal database) e componenti client: input, pulsanti, caricamento del PDF. Le pagine `employee`, `manager`, `finance` e la pagina iniziale la usano. |
| `fixtures/policy.md` | Policy di esempio, usata finché Finance non carica un PDF. Ha una lacuna voluta (pasti dei livelli superiori) e una regola aperta (altre spese). |

## Come decide l'agente

1. Il server costruisce il contesto: **indice delle sezioni** della policy e **solo gli estratti più pertinenti** (vedi sotto), profilo (nome, posizione, permesso), stato (importi già autorizzati o coda) e ultimi messaggi.
2. Il modello risponde con JSON: `reply`, `show` (scheda da allegare) e `proposal`, che compila solo quando è sicuro. Altrimenti chiede un chiarimento.
3. `verifyProposal` controlla la proposta sul testo completo della policy. Se fallisce, un solo nuovo tentativo con l'errore e più estratti. Se il modello dichiara la policy non chiara, un secondo giro con più estratti, perché la ricerca potrebbe aver perso la sezione giusta. Se fallisce ancora, il limite non viene inventato: la proposta diventa un caso non coperto (`policy_gap`) che deciderà il manager.
4. Il server calcola residuo, extra e priorità e mostra la scheda. Nessuna pratica esiste finché il dipendente non preme **Conferma invio**.
5. Approvazioni, ricevuta, rimborso ed export sono pulsanti. Il testo del modello non può eseguirle.

Limite noto: il server verifica che citazione e numero esistano nella policy, ma non che il numero valga per la posizione dell'utente quando la frase elenca più livelli. Per questo la scheda mostra la citazione al manager.

## Policy a pezzi

Il PDF caricato da Finance non va per intero nel prompt: si divide in sezioni e a ogni messaggio il modello riceve solo quelle pertinenti.

- **Estrazione:** `unpdf` restituisce il testo per pagina, in modo deterministico. Il modello non rilegge mai il PDF, quindi non può storpiare un numero. Niente OCR: un PDF scansionato viene rifiutato.
- **Chunking per struttura:** si spezza ai titoli (numerati, in maiuscolo o Markdown), non a finestre di dimensione fissa. Un limite resta con il suo titolo e le righe vicine, per esempio la tabella con i ruoli. Una sezione oltre 1200 caratteri si divide a righe intere e il titolo resta su ogni pezzo, con la pagina.
- **Ricerca:** BM25 locale sui pezzi, con titolo pesato doppio, radici troncate e piccoli sinonimi di dominio (taxi, treno, pasti, hotel, altre spese). La query unisce il messaggio, gli ultimi due dell'utente e la sua posizione, così le righe del suo livello emergono. Nessun embedding né servizio esterno, e il risultato è ripetibile.
- **Cosa vede il modello:** l'indice dei titoli (una riga per sezione) più i 4 estratti migliori, al massimo 6000 caratteri. Con più di 60 sezioni l'indice è troncato.
- **Rete di sicurezza:** se il modello dichiara il caso non coperto, o la proposta non regge, si ripete con 8 estratti prima di passare al manager.
- **Verifica:** la citazione è controllata sul testo completo. La sezione e la pagina salvate nella pratica vengono dal pezzo che la contiene.

Limiti: le tabelle del PDF diventano righe di testo e le colonne possono perdere l'allineamento. Dopo il caricamento la chat mostra le sezioni trovate perché Finance controlli. Il testo del PDF entra nel prompt: chi carica è Finance (fidato), e il server verifica comunque ogni proposta, ma un PDF malevolo potrebbe influenzare le risposte.

## Identità e controlli

Niente sessioni per ora. L'interfaccia sceglie l'utente con `?as=<uuid>` e lo manda come `actorId` a ogni chiamata. Il server **non si fida** del ruolo dichiarato dal client: legge il `permission` dal database e controlla stato e proprietà della pratica (`FlowError` 401, 403, 404, 409). L'`actorId` non è autenticato, quindi chiunque conosca un UUID può agire come quell'utente. Va sostituito con la sessione prima di qualsiasi uso reale.

Regole applicate in `lib/flow.ts`:
- Residuo = limite verificato meno quanto già autorizzato nella trasferta per la stessa categoria. Extra = importo meno residuo, mai negativo. Se la policy non copre il caso il residuo è zero.
- Priorità dall'urgenza (`immediate`, `day`, `week`, `later`), più un livello se l'extra supera 10 € (tetto 4).
- Extra a zero: autorizzata senza manager (evento `auto_approved_within_budget`).
- Il manager non decide sulla propria richiesta. Solo il proprietario conferma e carica la ricevuta. Solo Finance approva ed esporta.
- Ricevuta ≤ autorizzato: `pending_finance`. Oltre: `in_review`.
- Il canale `telegram` nelle decisioni lo imposta solo il codice del bot, mai il client.
- Le notifiche sono messaggi dell'assistente nella chat dell'altra persona (manager alla nuova richiesta, dipendente alla decisione, Finance alla ricevuta verificata).

## Carta virtuale e documenti

- **Quando nasce la carta:** solo con la pratica autorizzata (entro il residuo o approvata dal manager). Il server crea la riga `cards` in `pending` nella transazione, poi la route chiama `issueCard` dopo il commit. Il tetto (`all_time`) è l'autorizzato esatto, le categorie ammesse vengono dalla categoria di spesa, la carta è monouso: dopo il primo pagamento catturato è disattivata. Il limite lo applica Stripe, non c'è autorizzazione in tempo reale. Doppi clic o webhook più risposta API non duplicano carte né transazioni.
- **Deroga rifiutata:** niente Stripe. Con residuo maggiore di zero il dipendente paga con la propria carta fino al residuo, carica i documenti e riceve il rimborso a fine mese di `min(scontrino, residuo)`; l'eccedenza resta a suo carico (esito `capped`). Con residuo zero non c'è rimborso. Stesso percorso (`funding = personal`) se Stripe non è configurato o fallisce, e se il dipendente ha una pratica pagata con carta da oltre 7 giorni (`DOCUMENT_DEADLINE_DAYS`) senza documenti completi.
- **Documenti:** lo scontrino o la ricevuta è obbligatorio per ogni pratica, la fattura intestata all'azienda solo per le categorie con `requires_invoice`. Con la carta si caricano dopo il pagamento. Con tutti i documenti il server scrive la verifica: scontrino uguale alla transazione e non oltre l'autorizzato è `match` (in coda Finance), altrimenti `mismatch` o `over_authorized` (in revisione); fattura non intestata all'azienda manda in revisione.
- **UI:** il messaggio con la carta mostra ultime 4 cifre, tetto, categoria, stato, documenti richiesti e dati di fatturazione. Il popup «Ricordati la fattura» compare solo per le categorie con fattura. Il pulsante «Paga con la carta (sandbox)» e i pulsanti sintetici «Ricevuta» (scorciatoia demo) convivono con il caricamento reale. Finance vede funding ed esito e apre il Ticket PDF.

## Bot Telegram

Non ancora implementato. Pronti: il database e le funzioni `createLinkCode` e `redeemLinkCode` in `lib/flow.ts` (la UI genera già il codice). Il database ha `roles_and_users.telegram_chat_id` e `telegram_link_codes`. Il collegamento usa un codice monouso e il ruolo viene sempre letto dal database. Impostazioni, comandi e regole sono in [telegram.md](telegram.md).

## Dati

Importi sempre in centesimi. Tabelle (`STRICT`, chiavi esterne attive):

| Tabella | Contenuto |
|---|---|
| `trips` | `id`, `remaining_budget_cents`. |
| `roles` | `role` (PK: junior, senior, lead, director) e `description`. I limiti di spesa non sono nel database: li legge l'agente dalla policy. |
| `roles_and_users` | `id` (UUID), `name`, `role` (FK su `roles`, seniority), `permission` (`employee`, `manager`, `finance`), `telegram_chat_id` opzionale, `stripe_cardholder_id` (creato alla prima carta). |
| `telegram_link_codes` | Codici monouso con scadenza per associare `telegram_chat_id` a un utente. |
| `policy_documents` | Le policy: `version` (PK, impronta del testo), `filename`, `source` (`pdf`, `seed`), `pages`, `text`, `uploaded_by`, `active`. Una sola è attiva. |
| `policy_chunks` | Le sezioni: `version`, `idx`, `heading`, `page`, `text`. |
| `chat_messages` | Conversazione di ogni utente: ruolo (`user`, `assistant`), testo, scheda JSON opzionale e `request_id` quando una proposta è stata confermata. |
| `requests` | La pratica: utente, trasferta, categoria, importo, residuo, extra, importo autorizzato, stato, priorità (1-4) e regola, urgenza, versione policy, sezione e citazione della clausola, flag `policy_gap`, motivazione e `funding` (`card`, `personal`, vuoto per il percorso storico). |
| `approvals` | Decisioni (`manager`, `manager_supplement`, `finance`) con attore, canale (`web`, `telegram`) e ora. `UNIQUE (request_id, kind)`: una doppia approvazione lascia una sola decisione. |
| `receipts` | La verifica dei documenti, una per pratica: importo, esito (`match`, `over_authorized`, `capped`, `mismatch`) e `reimbursed_cents`. |
| `expense_categories` | Le categorie (vedi `lib/categories.ts`): categorie Stripe, MCC, `requires_invoice`, nota sulla fattura. |
| `cards` | La carta virtuale di una pratica (una sola): id Stripe, ultime 4 cifre, scadenza, tetto in centesimi, categorie ammesse, stato (`pending`, `active`, `inactive`, `failed`) ed errore. |
| `card_transactions` | I pagamenti catturati (id Stripe come chiave, quindi idempotenti): importo, esercente, MCC, ora, JSON grezzo. |
| `documents` | Scontrino e fattura di una pratica (`UNIQUE (request_id, kind)`): importo, esercente, P.IVA, intestazione all'azienda, origine (`upload`, `synthetic`), percorso del file ed estrazione. |
| `events` | Registro append-only collegato alla pratica e all'attore. |

Stati della pratica: `draft`, `pending_manager`, `approved`, `rejected`, `in_review`, `pending_finance`, `finance_approved`, `exported`.

## Configurazione

`.env.local` (non versionato, modello in `.env.example`): `GEMINI_GDG_KEY`, `GEMINI_MODEL` (default `gemini-3.5-flash-lite`), `TELEGRAM_BOT_TOKEN` (previsto, non ancora letto dal codice), `CARD_PROVIDER` (`simulator`, `lithic` o `stripe`), `LITHIC_API_KEY` (provider lithic), `STRIPE_SECRET_KEY` (provider stripe, solo chiavi `sk_test_`: una chiave live è rifiutata), `STRIPE_REGION` (provider stripe), `STRIPE_WEBHOOK_SECRET` (`whsec_…`, serve solo a `/api/stripe/webhook`). Se il provider scelto non è configurato non si generano carte e vale il percorso con carta personale. I documenti caricati stanno in `.data/documents/`.
