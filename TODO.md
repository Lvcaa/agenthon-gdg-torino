# Cosa manca

Elenco di lavoro del prototipo, in ordine di priorità. Lo stato reale è nel codice e in [docs/architecture.md](docs/architecture.md). Aggiorna questo file quando chiudi o aggiungi una voce.

## Fatto

- Percorso base del taxi da 42 € (30 € di residuo, 12 € di deroga): conferma del dipendente, decisione del manager, ricevuta, approvazione di Finance, CSV e registro.
- Chat con l'agente, policy PDF a pezzi, carta virtuale, documenti letti con Gemini, Ticket PDF.
- Notifiche simulate come messaggi in chat.
- Sezioni per ruolo:
  - **Dipendente, «Le mie richieste».** In corso, con l'etichetta dei documenti mancanti (scontrino, fattura o entrambi; la fattura solo se la categoria la richiede), e Completate.
  - **Manager.** Richieste in attesa con filtro per urgenza, più le sezioni Approvate e Rifiutate.
  - **Finance, «Note spese».** Ricerca per nome. Ogni nota spese è un ticket con download separati di scontrino, transazione e fattura (quando presenti) e il Ticket PDF completo.

## Da fare

1. **Storico delle deroghe** (vedi il piano). Conta le decisioni per tipo di spesa, fascia dell'extra e versione della policy: «4 richieste simili su 5 approvate». Con meno di 5 casi la chat mostra «Storico insufficiente».
2. **Revisione delle pratiche `in_review`.** Oggi una ricevuta oltre l'autorizzato o una fattura non intestata si ferma, come previsto, ma nessuno può sbloccarla. Facoltativo: una deroga integrativa del manager (`manager_supplement`), che poi entra anche nella sua coda.
3. **Bot Telegram per il manager.** Database e codice di collegamento sono già pronti, vedi [docs/telegram.md](docs/telegram.md).
4. **Sessioni vere al posto di `?as=<uuid>`.** Oggi chiunque conosca un UUID agisce come quell'utente. È un requisito per qualsiasi uso reale.
5. **Team del manager.** `roles_and_users` non ha un responsabile: ogni manager vede le richieste di tutti.

## Nice to have (per ultimo)

**Dashboard di Finance con aggregati e suggerimenti sulla policy.**

A livello di flusso utente, Finance ha una dashboard che si aggiorna a ogni nuova nota spese. Mostra gli aggregati degli ultimi X giorni, con X scelto da Finance:

- quanti soldi rientrano nella policy;
- quante eccezioni ci sono state (deroghe approvate o rifiutate, casi non coperti, ricevute oltre l'autorizzato);
- la stessa vista divisa per sezione della policy.

Aprendo una sezione, un agente segnala i pattern ricorrenti e suggerisce le modifiche alla policy. Esempio: «il 70 % dei taxi dei junior supera i 30 €, con un extra medio di 11 €: valuta di alzare il limite a 40 €».

Come farlo, in breve:

- **Aggregati.** Si calcolano lato server, in centesimi, da `requests` (`budget_cents`, `extra_cents`, `authorized_cents`, `policy_gap`, `clause_id`, `policy_version`, `created_at`), `approvals` e `receipts`. Nessun numero viene dal modello.
- **Che cosa rientra nella policy.** La parte entro il residuo (`authorized_cents - extra_cents`) rientra. L'extra approvato dal manager è un'eccezione. Un caso con `policy_gap` è non coperto.
- **Raggruppamento per sezione.** Si usa `clause_id`, che già salva sezione e pagina della clausola. Con versioni diverse della policy si filtra per versione, o si dichiara che i dati le mescolano.
- **Aggiornamento automatico.** Lo stesso `router.refresh()` ogni 3 secondi della chat. Il periodo sta nell'URL (`?days=30`).
- **Agente dei pattern.** Riceve gli aggregati già calcolati, il testo della sezione e un campione anonimo delle motivazioni. Risponde in JSON con i pattern e le proposte di modifica, ognuna con la citazione del testo da cambiare. Come per le proposte di spesa, il server verifica che la citazione esista nella sezione e che i numeri citati vengano dagli aggregati. Il suggerimento resta un consiglio: non modifica la policy, che Finance ricarica in PDF.
- **Soglia minima.** Sotto un numero minimo di casi (per esempio 5) l'agente non suggerisce nulla e la dashboard mostra «dati insufficienti», come lo storico delle deroghe.
