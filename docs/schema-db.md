# Schema del database

SQLite (`data/agenthon.sqlite`), tabelle `STRICT` con chiavi esterne attive. Importi in centesimi, date in ISO 8601 UTC. Definizione in [lib/db.ts](../lib/db.ts).

## Tabelle

### `trips`
Trasferta e budget residuo.

| Attributo | Tipo | Note |
|---|---|---|
| **id** | TEXT | **PK** (es. `T-042`) |
| remaining_budget_cents | INTEGER | ≥ 0 |

### `roles`
Posizioni lavorative (seniority). I limiti di spesa non sono nel database: sono scritti nella policy in testo libero (`fixtures/policy.md`) e li legge l'agente.

| Attributo | Tipo | Note |
|---|---|---|
| **role** | TEXT | **PK** (junior, senior, lead, director) |
| description | TEXT | |

### `roles_and_users`
Utenti sintetici con UUID e posizione.

| Attributo | Tipo | Note |
|---|---|---|
| **id** | TEXT | **PK**, UUID |
| name | TEXT | |
| role | TEXT | **FK** → `roles.role` (seniority) |
| permission | TEXT | `employee`, `manager`, `finance` |
| telegram_chat_id | TEXT | opzionale, `UNIQUE` |

### `telegram_link_codes`
Codici monouso per collegare una chat Telegram a un utente. Flusso e regole in [telegram.md](telegram.md).

| Attributo | Tipo | Note |
|---|---|---|
| **code** | TEXT | **PK** |
| user_id | TEXT | **FK** → `roles_and_users.id` |
| expires_at | TEXT | scadenza |
| used_at | TEXT | nullable, valorizzato all'uso |

### `policy_documents`
Le policy caricate. Una sola è attiva.

| Attributo | Tipo | Note |
|---|---|---|
| **version** | TEXT | **PK**, impronta del testo (8 caratteri): lo stesso contenuto ha la stessa versione |
| filename | TEXT | nome ripulito del file |
| source | TEXT | `pdf` (caricata da Finance), `seed` (esempio) |
| pages | INTEGER | > 0 |
| text | TEXT | testo estratto completo, usato per verificare le citazioni |
| uploaded_by | TEXT | **FK** → `roles_and_users.id`, nullable |
| uploaded_at | TEXT | |
| active | INTEGER | 0 o 1 |

### `policy_chunks`
Sezioni consultabili della policy.

| Attributo | Tipo | Note |
|---|---|---|
| **id** | INTEGER | **PK**, autoincrement |
| version | TEXT | **FK** → `policy_documents.version` |
| idx | INTEGER | ordine nel documento, `UNIQUE (version, idx)` |
| heading | TEXT | titolo, con `(n/m)` se la sezione è divisa |
| page | INTEGER | |
| text | TEXT | |

### `chat_messages`
Conversazione di ogni utente. È l'unica interfaccia.

| Attributo | Tipo | Note |
|---|---|---|
| **id** | INTEGER | **PK**, autoincrement |
| user_id | TEXT | **FK** → `roles_and_users.id` (proprietario della chat) |
| role | TEXT | `user`, `assistant` |
| content | TEXT | |
| card | TEXT | JSON opzionale: proposta, elenco pratiche, registro, codice Telegram |
| request_id | TEXT | pratica creata quando la proposta è stata confermata |
| created_at | TEXT | |

### `requests`
La pratica che attraversa tutto il flusso. Nasce quando il dipendente conferma la proposta dell'agente, mai prima (`draft` non è più usato).

| Attributo | Tipo | Note |
|---|---|---|
| **id** | TEXT | **PK** |
| trip_id | TEXT | **FK** → `trips.id` |
| user_id | TEXT | **FK** → `roles_and_users.id` |
| category | TEXT | `taxi`, `train`, `meals`, `hotel`, `other` |
| amount_cents | INTEGER | importo richiesto, > 0 |
| budget_cents | INTEGER | residuo al momento della richiesta |
| extra_cents | INTEGER | deroga richiesta, ≥ 0 |
| authorized_cents | INTEGER | importo autorizzato, nullable |
| status | TEXT | `draft`, `pending_manager`, `approved`, `rejected`, `in_review`, `pending_finance`, `finance_approved`, `exported` |
| priority | INTEGER | 1 (Bassa) – 4 (Urgente) |
| priority_rule | TEXT | regola applicata |
| urgency | TEXT | `immediate`, `day`, `week`, `later` (default `later`) |
| clause_quote | TEXT | citazione della policy verificata dal server, nullable |
| policy_gap | INTEGER | 1 se la policy non copre il caso e decide il manager |
| policy_version | TEXT | impronta del testo della policy (8 caratteri) |
| clause_id | TEXT | titolo della sezione della policy, es. `2. Trasporti locali (taxi)` |
| reason | TEXT | motivazione |
| created_at, updated_at | TEXT | |

### `approvals`
Decisioni su una pratica.

| Attributo | Tipo | Note |
|---|---|---|
| **id** | INTEGER | **PK**, autoincrement |
| request_id | TEXT | **FK** → `requests.id` |
| kind | TEXT | `manager`, `manager_supplement`, `finance` |
| decision | TEXT | `approved`, `rejected` |
| decided_by | TEXT | **FK** → `roles_and_users.id`, vuoto solo con `channel = 'agent'` |
| channel | TEXT | `web`, `telegram`, `agent` (approvazione automatica dei documenti coerenti) |
| amount_cents | INTEGER | nullable |
| decided_at | TEXT | |

Vincolo `UNIQUE (request_id, kind)`: una doppia approvazione lascia una sola decisione.

### `receipts`
Ricevuta collegata alla pratica.

| Attributo | Tipo | Note |
|---|---|---|
| **id** | TEXT | **PK** |
| request_id | TEXT | **FK** → `requests.id`, `UNIQUE` |
| amount_cents | INTEGER | > 0 |
| outcome | TEXT | `match`, `over_authorized`, `capped`, `mismatch` |
| raw_json | TEXT | ricevuta, con `checks`: i controlli della riconciliazione |
| reimbursed_cents | INTEGER | nullable |
| verified_at | TEXT | |

### `events`
Registro append-only.

| Attributo | Tipo | Note |
|---|---|---|
| **id** | INTEGER | **PK**, autoincrement |
| request_id | TEXT | **FK** → `requests.id`, nullable |
| actor_id | TEXT | **FK** → `roles_and_users.id`, nullable |
| type | TEXT | tipo di evento |
| payload | TEXT | JSON |
| created_at | TEXT | |

## Relazioni

```
policy_documents 1───* policy_chunks

roles 1───* roles_and_users 1───* telegram_link_codes
                   │
                   1───* chat_messages
                   │
                   1───* requests *───1 trips
                   │                  │
                   │                  ├──* approvals   (decided_by → roles_and_users)
                   │                  ├──1 receipts
                   └──────────────────┴──* events      (actor_id → roles_and_users)
```

## Stati della pratica

```
(proposta in chat) → pending_manager → approved → pending_finance → finance_approved → exported
                │              └──→ in_review (ricevuta oltre l'autorizzato)
                └──→ rejected
```
