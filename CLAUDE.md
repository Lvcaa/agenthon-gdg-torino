# Istruzioni per gli agenti

## Contesto da caricare

- Parti dai file coinvolti nel task. Apri [il piano](docs/piano-hackathon.md) solo per chiarire requisiti, priorità, collaudo o demo. Cerca la sezione pertinente con `rg`.
- Leggi [l’architettura](docs/architecture.md) per endpoint, moduli e tabelle. Aggiornala nello stesso commit quando aggiungi o modifichi un endpoint, un modulo, una tabella o una variabile d’ambiente.
- Verifica lo stato del progetto nel codice. Il piano descrive obiettivi e funzionalità previste. Tieni nel README i comandi di avvio e verifica quando esistono.

## Priorità di sviluppo

- Prima chiudi il percorso taxi da **42 €**, con **30 €** residui e **12 €** di deroga. Il dipendente conferma l’invio, il manager decide, la ricevuta arriva a Finance e Finance autorizza il CSV. Registra le decisioni.
- Dopo il collaudo del percorso base, aggiungi chat, notifica simulata e storico, in quest’ordine. La ricevuta fuori soglia deve fermarsi. Lo sblocco con una seconda deroga è facoltativo.
- Stack previsto per il prototipo locale: Next.js, TypeScript, SQLite e policy JSON versionata. Usa dati sintetici. Passa la policy direttamente nel contesto quando serve.

## Vincoli da verificare

- Il modello estrae i dati della domanda. Il server calcola importi in centesimi e verifica stato e ruolo della sessione prima di invio, approvazione ed export.
- Per le modifiche al flusso, verifica il percorso positivo e i blocchi pertinenti. Il dipendente può inviare la richiesta, il manager può autorizzare la deroga e Finance può autorizzare l’export. Una doppia approvazione lascia una sola decisione.
