# Bot Telegram · impostazioni

Documento vivo: aggiornalo a ogni modifica del bot, dei comandi o delle variabili. Stato: **bot non ancora implementato**. Sono pronti la generazione del codice (si chiede in chat: «collega Telegram»), la funzione `redeemLinkCode` in `lib/flow.ts` con i suoi test, la tabella `telegram_link_codes` e la colonna `roles_and_users.telegram_chat_id`.

Il bot è un secondo canale verso la stessa pratica. Rappresenta il manager che approva i ticket, e il dipendente può usarlo per chiedere budget e regole. La pagina `/phone` resta come riserva.

## Impostazioni

| Voce | Valore | Stato |
|---|---|---|
| Creazione | BotFather, comando `/newbot`. Nome e username a scelta del team. | da fare |
| Token | `TELEGRAM_BOT_TOKEN` in `.env.local`. Il modello è in `.env.example`. Non va mai nel repository né nei log. | placeholder presente |
| Ricezione aggiornamenti | Long polling con `getUpdates`. Nessun webhook e nessun URL pubblico. Un bot non può usare webhook e `getUpdates` insieme. | scelta fatta |
| Aggiornamenti richiesti | `message` e `callback_query`. | da configurare |
| Dati | Solo dati sintetici. | regola |
| Lingua | Italiano. | scelta fatta |

## Collegamento chat e utente

Il ruolo non è mai dichiarato dall'utente su Telegram. Viene sempre dal database.

1. Nella chat web, l'utente chiede di collegare Telegram e l'agente mostra un codice. Il server scrive una riga in `telegram_link_codes` con `user_id` e scadenza di 10 minuti (valore provvisorio).
2. L'utente scrive `/start` al bot e invia il codice.
3. Il server verifica che il codice esista, non sia scaduto e non sia già usato.
4. Il server imposta `roles_and_users.telegram_chat_id`, segna `used_at` e scrive un evento nel registro.
5. Il bot risponde con nome, posizione e budget letti dal database.

Casi da gestire: codice scaduto, già usato o sbagliato, chat già collegata a un altro utente (vincolo `UNIQUE`), utente già collegato a un'altra chat.

## Comandi

| Comando | Chi | Effetto |
|---|---|---|
| `/start` | tutti | Chiede il codice di collegamento. Se la chat è già collegata, mostra il profilo. |
| `/profilo` | collegati | Nome, posizione e budget per categoria dal database. |
| `/coda` | manager | Ticket in attesa, ordinati per priorità. |
| `/scollega` | collegati | Rimuove `telegram_chat_id` e scrive un evento. |
| Testo libero | dipendente collegato | Va all'agente con la policy e il profilo letti dal database. |

L'elenco è provvisorio. Aggiornalo quando i comandi vengono implementati.

## Notifica del ticket al manager

Il messaggio contiene richiesta, dipendente, categoria, importo, extra, clausola, priorità e due pulsanti, **Approva** e **Rifiuta**.

- I pulsanti sono *inline keyboard*. `callback_data` ha un limite di 64 byte, quindi contiene solo azione e id della pratica, per esempio `approve:<request_id>`.
- Il bot risponde al tocco con `answerCallbackQuery` e aggiorna il messaggio con l'esito.
- Ogni tocco chiama lo stesso endpoint di decisione della web app, con canale `telegram`.

## Regole di sicurezza

- Il server identifica l'utente da `telegram_chat_id`. Il testo del messaggio non può cambiare ruolo o permessi.
- Solo un utente con `permission = manager` può approvare o rifiutare. Solo `finance` può autorizzare l'export. Il bot non offre l'export.
- Il server verifica che la pratica sia in `pending_manager` e che il manager non sia il richiedente.
- Un secondo tocco sulla stessa pratica non crea una seconda decisione (`UNIQUE (request_id, kind)`).
- Una chat non collegata riceve solo l'invito a collegarsi.
- Il token è un segreto. Se compare in un log, in un commit o in un messaggio, va revocato con BotFather e rigenerato.

## Collaudo

- [ ] Il collegamento con codice valido associa la chat all'utente giusto.
- [ ] Un codice scaduto, già usato o errato viene rifiutato.
- [ ] Una chat non collegata non può approvare.
- [ ] Un dipendente collegato non può approvare, nemmeno con un `callback_data` costruito a mano.
- [ ] **Approva** su Telegram produce la stessa decisione della web app, con canale `telegram` nel registro.
- [ ] Un secondo tocco sullo stesso ticket non crea una seconda decisione.
- [ ] Se il bot non risponde, `/phone` mostra lo stesso ticket.

## Da decidere

- Scadenza e formato del codice di collegamento (provvisorio: 10 minuti).
- Username e nome del bot.
- Se il dipendente riceve su Telegram anche l'esito della deroga.
