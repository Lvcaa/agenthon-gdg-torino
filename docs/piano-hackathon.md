# AGENTHON · Team Gatti

## Agente per spese e rimborsi di trasferta

**Traccia B · Autopilota per il back office**  
**Sponsor della traccia · Ariete Tech Solutions**

> «Sono davanti alla stazione. Il taxi costa 42 €. Rientra nel budget della mia trasferta?»

L’agente risponde in base alla policy aziendale e al budget della trasferta. Quando serve una deroga, prepara la richiesta e, dopo la conferma del dipendente, la invia al manager. All’arrivo della ricevuta confronta la spesa effettiva con l’importo autorizzato, aggiorna la coda dei rimborsi e prepara il CSV. Finance autorizza l’export. La stessa pratica collega tutte le decisioni, dalla domanda iniziale al file contabile.

## La traccia B

La sfida chiede di automatizzare un processo di back office dall’input grezzo all’output finale. L’agente lavora in background dove può, si ferma davanti alle eccezioni e chiede l’intervento della persona competente prima di azioni come inviare, pagare o esportare dati. Il team deve dimostrare un problema aziendale concreto e il tempo o il denaro che il processo può risparmiare. Il registro deve rendere visibili gli input, le operazioni e chi le ha approvate.

La demo usa esclusivamente policy, account, ricevute e decisioni sintetici. Il pitch dura circa tre minuti e mostra problema, soluzione e dimostrazione funzionante. [Portale AGENTHON](https://agenthon-portal.gdgtorino.it/)

## Target e valore

| Utente | Problema | Risultato |
|---|---|---|
| **Dipendente in trasferta** | Deve decidere sul momento e rischia di anticipare una spesa che supera il budget disponibile. | Riceve una risposta con la clausola applicata, il residuo e l’eventuale extra da chiedere. |
| **Manager** | Riceve richieste incomplete e deve ricostruire importi e motivazioni. | Riceve una richiesta pronta da valutare, con importi, regola e decisione richiesta. |
| **Finance** | Controlla che ricevute e approvazioni corrispondano e ricopia i dati. | Trova le pratiche verificate nella coda rimborsi e autorizza il CSV con un registro consultabile. |

Per misurare il valore, eseguite lo stesso caso sintetico una volta a mano e una volta con il prototipo. Sommate i minuti attivi di dipendente, manager e Finance in ciascuna prova. Se fate una proiezione mensile, dichiarate il volume ipotizzato e presentate la misura come risultato di una prova di demo.

## Flusso di lavoro

| Passaggio | Cosa fa l’agente | Decisione o esito |
|---|---|---|
| **1. Domanda** | Interpreta una domanda sul taxi. Il backend verifica la policy vigente e legge il budget della trasferta. Se manca l’importo, l’assistente lo chiede. | Il dipendente vede che il taxi è ammesso, ma con **30 €** residui su **42 €** di spesa stimata serve una deroga di **12 €**. |
| **2. Richiesta** | Prepara il ticket con importo, motivazione e riferimento alla policy. | Il dipendente conferma l’invio. La richiesta compare nella coda del manager. |
| **3. Deroga** | Mostra la richiesta e registra la decisione. | Il manager approva il taxi fino a **42 €** oppure rifiuta la deroga. Una pratica rifiutata esce dalla coda operativa di Finance. |
| **4. Ricevuta** | All’arrivo del file sintetico, collega la ricevuta alla pratica e verifica l’importo. | A **42 €** la pratica passa automaticamente a Finance. A **48 €** resta in revisione. |
| **5. Rimborso** | Aggiorna la tabella Finance e prepara i dati contabili. | Finance approva il rimborso. Il backend abilita il download della riga CSV. |
| **6. Registro** | Collega gli eventi alla stessa pratica. | Si possono ricostruire i dati iniziali, la versione della policy, la ricevuta, gli importi, gli approvatori e l’ora delle decisioni. |

### Funzioni incrementali

- **Telefono simulato.** La pagina `/phone` si apre in una seconda finestra del PC con la sessione manager. Controlla la coda ogni due secondi. Dopo l’invio del dipendente compare «Deroga taxi · +12 €» e un clic apre la richiesta effettiva.
- **Storico delle deroghe.** Il backend conta le decisioni sintetiche per tipo di spesa, fascia dell’extra e versione della policy. La chat mostra «4 richieste simili su 5 approvate». Con meno di cinque casi mostra «Storico insufficiente». Il dato è una frequenza osservata e la soglia è una scelta del prototipo.
- **Ricevuta sopra il tetto autorizzato.** La variante da 48 € aggiunge una richiesta integrativa di **6 €** rispetto ai 42 € già autorizzati. Il dipendente conferma l’invio e il manager decide sulla differenza prima del passaggio a Finance. Nel prototipo base la pratica resta semplicemente in revisione.

## Stack e confini del prototipo

| Componente | Scelta |
|---|---|
| **Web app e API** | Next.js + TypeScript. Riutilizzare uno starter funzionante se già disponibile. |
| **Persistenza** | SQLite locale per pratica, approvazioni, storico ed eventi. Dati sintetici precaricati per ripristinare lo scenario tra le prove. |
| **Policy** | JSON versionato con una clausola sulla spesa taxi. Il server legge direttamente la policy. Per una sola clausola il contesto diretto basta. |
| **Modello** | Una chiamata con output strutturato per classificare la spesa ed estrarre l’importo. Il modulo iniziale resta disponibile se il modello non risponde. |
| **Controlli** | Il backend usa importi in centesimi, legge il ruolo dalla sessione e verifica lo stato prima di ogni transizione. Una doppia approvazione produce una sola decisione. |
| **Input e output** | Ricevute sintetiche in JSON, coda Finance in tabella, CSV contabile scaricabile dopo l’approvazione e registro consultabile. |
| **Notifica** | Pagina mobile simulata sul PC, alimentata dallo stato reale della pratica. |

Il piano assume una demo locale e una chiave API funzionante. Verificate subito l’eventuale requisito di pubblicazione. La priorità di sviluppo va al flusso dei rimborsi, con una policy e un caso taxi. OCR, pagamenti effettivi, push reali e integrazioni contabili sono fuori dallo scope del prototipo.

## Piano di sviluppo · 4 ore e 30 minuti

| Tempo | Luca · sviluppo | Compagno · processo, collaudo e consegna | Traguardo |
|---|---|---|---|
| **0:00–0:15** | Avvia lo starter. Concorda campi, stati e interfacce minime. | Verifica scadenza, formato della submission ed eventuale URL pubblico. Definisce regola taxi e importi. | App avviata, scenario condiviso e requisiti di consegna chiari. |
| **0:15–1:15** | Implementa richiesta, decisione manager, verifica ricevuta, coda Finance, approvazione, CSV e registro. Usa input fissi e UI essenziale. | Prepara policy, ricevute da 42 € e 48 €, riga CSV attesa, storico sintetico e casi di prova. Cronometra il processo manuale. | Il caso da 42 € arriva al file contabile. |
| **1:15–1:30** | Verifica ruoli, stati e blocco dell’export. Salva la versione base funzionante. | Esegue il collaudo senza assistenza e registra i problemi riproducibili. | **Prototipo end-to-end pronto entro 90 minuti.** |
| **1:30–2:05** | Collega la chat al flusso esistente. Gestisce importo mancante e modulo di riserva. | Prova domande diverse, prepara la descrizione per la giuria e verifica il riferimento alla clausola. | La chat conduce alla stessa pratica già collaudata. |
| **2:05–2:30** | Collega la pagina del telefono alla coda manager. | Verifica il cambio di stato in due finestre con sessioni distinte. | La notifica compare dopo la conferma del dipendente. |
| **2:30–2:50** | Aggiunge il conteggio dei precedenti simili. | Verifica il conteggio e cronometra il processo assistito. | La chat mostra lo storico o segnala che i dati sono insufficienti. |
| **2:50–3:25** | Implementa la richiesta integrativa solo se il caso base passa due volte di fila. | Verifica il caso da 48 €, prepara pitch e submission. | Il caso integrativo funziona oppure si mantiene il caso base per il pitch. |
| **3:25–4:30** | Corregge i blocchi di demo. Prepara il reset e le finestre del browser. | Conduce due prove cronometrate, registra una demo di riserva e completa la submission. | Due prove sotto tre minuti, demo ripetibile e consegna completata. |

**Se al minuto 90 l’export è ancora incompleto, sospendete le aggiunte.** Completate il percorso base, poi collegate la chat. In caso di ritardo, tagliate prima la deroga integrativa, poi lo storico. Per la notifica basta un banner nella pagina manager. Dal minuto **205**, la priorità è consegnare.

## Collaudo prima del pitch

- [ ] La ricevuta da **42 €** produce una riga CSV con l’importo corretto dopo l’ok di Finance.
- [ ] Il dipendente che prova ad approvare la propria deroga riceve un rifiuto dal server.
- [ ] L’export richiesto prima dell’approvazione Finance viene bloccato dal server.
- [ ] Una deroga rifiutata resta fuori dalla coda Finance e il registro mostra il rifiuto.
- [ ] La ricevuta da **48 €** lascia la pratica in revisione. Se è disponibile la richiesta integrativa, la seconda deroga vale **6 €**.
- [ ] Due clic su **Approva** lasciano una sola decisione nel registro.
- [ ] Dopo il reset, il caso riparte con **30 €** residui e le due finestre mantengono sessioni distinte.

## Demo end-to-end · 3 minuti

| Tempo | Scena | Chi parla |
|---|---|---|
| **0:00–0:30** | «Sono davanti alla stazione. Posso prendere un taxi da 42 €?» Mostrate il problema e i 30 € disponibili. | Compagno |
| **0:30–1:25** | La chat mostra la clausola e i 12 € di extra. Il dipendente conferma l’invio e il telefono simulato riceve la notifica. Luca apre il ticket e approva come manager. | Compagno, poi Luca |
| **1:25–2:30** | Caricate la ricevuta da 42 €. La pratica entra nella coda Finance. Provate l’export prima dell’ok, approvate e scaricate il CSV. | Luca |
| **2:30–3:00** | Aprite il registro, mostrate le due approvazioni e riportate il tempo misurato durante la prova. | Luca, poi compagno |

Mostrate il caso da **48 €** come variante solo se il percorso con la seconda notifica rientra nei tre minuti durante le prove. Tenete la ricevuta da 42 € pronta per ripetere la demo base.

## Criteri di valutazione

| Criterio della giuria | Cosa mostriamo |
|---|---|
| **Innovazione** | Interveniamo prima che il dipendente spenda. Colleghiamo il consiglio su policy e budget alla deroga e al rimborso. Lo storico, se disponibile, dà al dipendente un precedente concreto. |
| **Aderenza al tema** | Un processo di back office completo, con verifica automatica all’arrivo della ricevuta, intervento del manager sull’eccezione e autorizzazione Finance per l’export. |
| **Fattibilità oltre il prototipo** | Ruoli distinti, una policy versionata, una coda Finance e un CSV utilizzabile. In produzione servirebbero fonti aziendali affidabili per policy e saldi, identità aziendali e integrazione con la contabilità. |
| **Qualità dell’esecuzione tecnica** | Il backend applica ruoli e condizioni di approvazione, blocca l’export al momento giusto e collega ricevuta, decisioni e attori nel registro. |
| **Qualità del pitch** | Seguiamo lo stesso taxi in tutte le schermate. La notifica rende visibile il passaggio al manager e il blocco dell’export dimostra il controllo umano. |

## Risposta al mentor · perché un’app oltre alla skill

Una skill può essere il punto d’ingresso per la domanda «Posso prendere questo taxi?». L’app conserva una pratica che resta aperta dopo la chat e passa tra dipendente, manager e Finance. Tiene insieme **quanto è stato chiesto, quanto è stato approvato, quanto è stato speso e chi ha autorizzato l’export**. Una skill potrebbe usare le stesse API per avviare il flusso. Nel tempo, le integrazioni con budget e contabilità e uno storico aziendale affidabile potrebbero rendere il prodotto più difficile da replicare.
