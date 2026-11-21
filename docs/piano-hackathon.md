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
| **1. Domanda** | L’agente legge la policy in testo libero e interpreta una domanda sul taxi. Trova il limite del profilo con la citazione della clausola e tiene conto di quanto è già autorizzato. Se manca l’importo, lo chiede. Il server verifica la citazione. | Il dipendente vede che il taxi è ammesso, ma con **30 €** residui su **42 €** di spesa stimata serve una deroga di **12 €**. |
| **2. Richiesta** | Prepara il ticket con importo, motivazione, riferimento alla policy e **etichetta di priorità**. | Il dipendente conferma l’invio. La richiesta compare nella coda del manager, ordinata per priorità. |
| **3. Deroga** | Mostra la richiesta e registra la decisione. | Il manager approva il taxi fino a **42 €** oppure rifiuta la deroga. Una pratica rifiutata esce dalla coda operativa di Finance. |
| **4. Ricevuta** | All’arrivo del file sintetico, collega la ricevuta alla pratica e verifica l’importo. | A **42 €** la pratica passa automaticamente a Finance. A **48 €** resta in revisione. |
| **5. Rimborso** | Aggiorna la tabella Finance e prepara i dati contabili. | Finance approva il rimborso. Il backend abilita il download della riga CSV. |
| **6. Registro** | Collega gli eventi alla stessa pratica. | Si possono ricostruire i dati iniziali, la versione della policy, la ricevuta, gli importi, gli approvatori e l’ora delle decisioni. |

### Funzioni incrementali

- **Telefono simulato.** La pagina `/phone` si apre in una seconda finestra del PC con la sessione manager. Controlla la coda ogni due secondi. Dopo l’invio del dipendente compare «Deroga taxi · +12 €» e un clic apre la richiesta effettiva.
- **Bot Telegram per il manager.** Il manager riceve il ticket su Telegram con importo, regola, priorità e due pulsanti, **Approva** e **Rifiuta**. Il bot è un secondo canale verso la stessa pratica: la pagina `/phone` resta come riserva se Telegram non risponde. Il collegamento usa un codice monouso con scadenza, generato nella web app dall’utente già autenticato: il bot associa la chat a quell’utente e legge ruolo e budget dal database. L’utente non dichiara mai il proprio ruolo su Telegram. Dopo il collegamento il bot risponde in base al profilo, ad esempio con il budget residuo del dipendente. Il bot interroga Telegram a intervalli regolari (long polling), così la demo locale non richiede un URL pubblico. Ogni pulsante chiama lo stesso endpoint di decisione dell’interfaccia web: il server verifica che la chat appartenga a un manager, che il ticket sia in attesa e che la decisione sia unica. Il registro indica il canale usato, web o Telegram. Il bot invia solo dati sintetici. Le impostazioni sono in [telegram.md](telegram.md).
- **Storico delle deroghe.** Il backend conta le decisioni sintetiche per tipo di spesa, fascia dell’extra e versione della policy. La chat mostra «4 richieste simili su 5 approvate». Con meno di cinque casi mostra «Storico insufficiente». Il dato è una frequenza osservata e la soglia è una scelta del prototipo.
- **Profili per seniority.** L’account sintetico porta con sé la posizione (junior, senior, lead, director). La policy è testo libero e scrive i limiti per posizione in linguaggio naturale. L’agente trova nel testo il limite che vale per chi scrive, quindi la stessa spesa da 42 € ha esiti diversi per profili diversi. Il caso base resta il junior con **30 €** residui.
- **Mappa delle spese di trasferta.** La policy copre taxi, treno, cibo, hotel e altre spese. Il dipendente descrive una spesa o la trasferta e l’agente ricava le regole dal testo. Dove la policy non dice abbastanza, per esempio i pasti dei livelli superiori o i parcheggi, l’agente non inventa un limite: segnala che la policy non è chiara e la decisione passa al manager.
- **Carta virtuale simulata.** Dopo l’approvazione, o subito se la spesa rientra nel budget del profilo, il backend genera una carta virtuale fittizia legata alla pratica. Il plafond coincide con l’importo autorizzato (42 € nel caso base), la carta vale per una sola spesa e per la categoria della pratica, e il dipendente non anticipa denaro. La ricevuta riconcilia la spesa con il plafond: a 42 € la pratica passa a Finance, a 48 € resta in revisione. Il CSV diventa una riga di chiusura contabile. Nessun circuito reale e nessun pagamento: il numero della carta è sintetico e il plafond è un campo del database.
- **Ricevuta sopra il tetto autorizzato.** La variante da 48 € aggiunge una richiesta integrativa di **6 €** rispetto ai 42 € già autorizzati. Il dipendente conferma l’invio e il manager decide sulla differenza prima del passaggio a Finance. Nel prototipo base la pratica resta semplicemente in revisione.

### Priorità del ticket

Ogni ticket in arrivo al manager porta un’etichetta con quattro livelli, dal più basso al più urgente.

| Livello | Etichetta | Quando si applica |
|---|---|---|
| **1** | Bassa | La spesa è prevista tra più di sette giorni. |
| **2** | Normale | La spesa è prevista entro sette giorni. |
| **3** | Alta | La spesa è prevista entro 24 ore. |
| **4** | Urgente | Il dipendente deve spendere subito e aspetta la risposta, come nel caso del taxi davanti alla stazione. |

- Il livello nasce dal momento in cui serve la risposta, che il modello estrae dalla domanda. Se il momento manca, l’assistente lo chiede e il modulo di riserva offre i quattro valori.
- Un extra sopra una soglia (10 €, scelta del prototipo e fissata nel codice) alza il ticket di un livello. Il tetto resta **Urgente**.
- Il server assegna la priorità e salva il valore e la regola applicata. Il manager non la modifica, e il dipendente non la imposta a mano, per evitare che ogni richiesta risulti urgente.
- La coda del manager si ordina dal livello più alto, poi per ora di invio. La pagina `/phone` mostra l’etichetta nella notifica. Il registro conserva la priorità assegnata.
- Nel caso base il taxi da 42 € è **Urgente**, con 12 € di extra.

## Stack e confini del prototipo

| Componente | Scelta |
|---|---|
| **Web app e API** | Next.js + TypeScript. Riutilizzare uno starter funzionante se già disponibile. |
| **Persistenza** | SQLite locale per pratica, approvazioni, storico ed eventi. Dati sintetici precaricati per ripristinare lo scenario tra le prove. |
| **Policy** | Un PDF con testo selezionabile, che contiene almeno tetti per ruolo o livello (non criteri vaghi come «hotel ragionevole»). Lo carica Finance dalla chat. Il testo si estrae con `unpdf`, si divide per sezioni e il modello riceve solo l’indice e gli estratti pertinenti, così il costo per messaggio non cresce con la lunghezza del documento. Il testo completo serve al server per verificare le citazioni. Senza PDF caricato si usa una policy di esempio. |
| **Modello** | Gemini interpreta la conversazione. Quando è sicuro restituisce una proposta strutturata con categoria, importo, urgenza, limite per il profilo e **citazione testuale** della policy. Se non è sicuro, chiede o dichiara la policy non chiara. Se il modello non risponde, la chat lo dice e nessuna pratica viene toccata. |
| **Controlli** | Il server verifica la proposta: la citazione deve comparire nella policy, il limite deve essere scritto nella citazione, gli importi sono interi in centesimi. Se non regge, c’è un solo nuovo tentativo con l’errore, poi il caso va al manager come policy non chiara. Il server calcola residuo, extra e priorità, legge il ruolo dall’utente e verifica lo stato prima di ogni transizione. Una doppia approvazione produce una sola decisione. |
| **Interfaccia** | Solo chat, una per utente. L’agente mostra sotto i messaggi schede con i pulsanti di conferma, approvazione, ricevuta, rimborso e CSV. Le azioni partono dai pulsanti e mai dal testo del modello. Le altre persone ricevono le notifiche come messaggi nella loro chat. |
| **Input e output** | Ricevute sintetiche in JSON, coda Finance mostrata in chat, CSV contabile scaricabile dopo l’approvazione e registro consultabile dalla chat. |
| **Notifica** | Pagina mobile simulata sul PC, alimentata dallo stato reale della pratica. Come canale opzionale, un bot Telegram per il manager, con la pagina simulata come riserva. |

Il piano assume una demo locale e una chiave API funzionante. Verificate subito l’eventuale requisito di pubblicazione. La priorità di sviluppo va al flusso dei rimborsi, con una policy e un caso taxi. OCR, pagamenti effettivi e integrazioni contabili sono fuori dallo scope del prototipo. Le notifiche push dell’app sono simulate. L’unico canale esterno reale è il bot Telegram del manager, con dati sintetici e un token creato per la demo.

## Crescita progressiva del prodotto

Ogni livello riusa il flusso del precedente e parte solo quando il precedente passa il collaudo. Nel pitch i livelli successivi al primo si presentano come direzione di sviluppo, a meno che le prove non li abbiano resi stabili.

| Livello | Cosa si aggiunge | Cosa resta invariato | Condizione per procedere |
|---|---|---|---|
| **1. Taxi, un profilo** | Percorso completo da domanda a CSV, con **30 €** residui e **12 €** di deroga. | Ruoli dipendente, manager e Finance. | Collaudo base superato. |
| **2. Chat, notifica, storico** | Funzioni incrementali già descritte sopra. Il bot Telegram del manager si aggiunge dopo la notifica simulata, perché usa lo stesso endpoint di decisione. | Pratica, stati e registro. | Il caso base passa due volte di fila. |
| **3. Seniority** | Posizione nell’account e limiti per posizione scritti nel testo della policy. L’agente trova il limite del profilo. | Verifica della citazione e calcolo degli importi lato server. | Due profili danno esiti diversi sullo stesso taxi. |
| **4. Categorie di trasferta** | La policy testuale copre treno, cibo, hotel e altre spese. Una domanda sulla trasferta restituisce le voci attese e il residuo di ciascuna. | Flusso di deroga, ricevuta, coda Finance e CSV. | Una seconda categoria completa il percorso fino al CSV. |
| **5. Carta virtuale simulata** | Carta con plafond pari all’importo autorizzato, generata dopo l’approvazione o dentro il budget del profilo. La ricevuta riconcilia la spesa con il plafond. | Decisioni, registro e approvazione Finance dell’export. | Il caso taxi da 42 € passa dalla carta alla riga CSV. |
| **6. Trasferta completa** | Budget complessivo della trasferta che somma le categorie, con residuo aggiornato a ogni pratica. | Registro unico per pratica e per trasferta. | Fuori dallo scope della demo. Resta nella roadmap. |

I limiti per posizione vengono dalla policy letta dall’agente. La carta eredita il limite verificato e non può superarlo. In produzione la carta richiederebbe un emittente reale, controlli antifrode e un’integrazione con la contabilità, quindi nel pitch la presentiamo come evoluzione naturale del rimborso.

Il server calcola sempre importi, residui ed extra. Il modello legge la policy e propone limite e citazione, ma il server verifica la citazione e non accetta limiti che il testo non contiene.

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

**Se al minuto 90 l’export è ancora incompleto, sospendete le aggiunte.** Completate il percorso base, poi collegate la chat. In caso di ritardo, tagliate prima le categorie oltre al taxi, poi la carta virtuale, poi i profili per seniority, poi la deroga integrativa, poi lo storico. Per la notifica basta un banner nella pagina manager, e il bot Telegram si taglia per primo tra le funzioni di notifica. Dal minuto **205**, la priorità è consegnare.

## Collaudo prima del pitch

- [ ] La ricevuta da **42 €** produce una riga CSV con l’importo corretto dopo l’ok di Finance.
- [ ] Il dipendente che prova ad approvare la propria deroga riceve un rifiuto dal server.
- [ ] L’export richiesto prima dell’approvazione Finance viene bloccato dal server.
- [ ] Una deroga rifiutata resta fuori dalla coda Finance e il registro mostra il rifiuto.
- [ ] La ricevuta da **48 €** lascia la pratica in revisione. Se è disponibile la richiesta integrativa, la seconda deroga vale **6 €**.
- [ ] Il ticket del taxi arriva al manager con etichetta **Urgente**. La coda mette in cima il ticket di priorità più alta, e il client non può cambiare l’etichetta.
- [ ] Il pulsante **Approva** su Telegram produce la stessa decisione dell’interfaccia web. Una chat non collegata a un manager riceve un rifiuto dal server, e un secondo tocco sullo stesso ticket non crea una seconda decisione.
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
