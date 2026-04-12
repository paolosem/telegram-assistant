# Regia OS (Telegram + Dashboard)

MVP Telegram con comandi per automazioni da CEO e assistenza creativa.

## Setup rapido
1) Copia `.env.example` in `.env` e inserisci i token.
2) Installa dipendenze:
   ```bash
   npm install
   ```
3) Avvia il bot:
   ```bash
   npm start
   ```

## Deploy su Render (PC spento)
1) Carica il progetto su GitHub.
2) Su Render crea un nuovo `Web Service` collegando il repo.
3) Imposta:
   - Root directory: `.`
   - Build command: `npm install`
   - Start command: `npm start`
4) Variabili ambiente su Render:
   - `TELEGRAM_BOT_TOKEN`
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL=gpt-4o-mini`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI=https://<tuo-servizio>.onrender.com/oauth2callback`
   - `APP_BASE_URL=https://<tuo-servizio>.onrender.com`
5) In Google Cloud OAuth aggiungi la Redirect URI di Render (stessa del punto sopra).
6) Dopo il deploy, su Telegram esegui `/gcal` per ricollegare Google.

Nota: usa un piano sempre attivo (es. `starter`) se vuoi invio mattutino affidabile.

## Google Calendar (OAuth)
1) Vai su Google Cloud Console e crea un progetto.
2) Abilita l'API "Google Calendar".
3) Crea credenziali OAuth (Tipo: "Applicazione desktop").
4) Copia Client ID e Client Secret in `.env`:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback`
5) Avvia il bot, poi su Telegram usa `/gcal` e segui il link.

## Comandi
- /brief
- /meet <contesto>
- /idea <tema>
- /post <tema>
- /followup <contesto>
- /tone <stile>
- /task_add <testo>
- /task_list
- /task_done <id>
- /task_today
- /task_next
- /gcal
- /gcal_status
- /gcal_disconnect
- /morning_on
- /morning_off
- /morning_time HH:MM
- /morning_now
- /morning_tomorrow
- /gtasks_now
- /gcal_events [oggi|domani|ieri|YYYY-MM-DD|DD/MM/YYYY]
- /gcal_events7
- /gcal_calendars
- /gcal_use <id>
- /gcal_use all

## Task (livello 2)
Esempi:
- `/task_add Preparare proposta Q4 alta domani #sales`
- `/task_add Aggiornare KPI media 2026-02-28 #ops`
- `/task_list`
- `/task_today`
- `/task_done 3`

## Messaggio mattutino
- Ogni mattina ricevi un riepilogo con: mail non lette, task aperte Google Tasks, appuntamenti del giorno e un link a un articolo de Il Post.
- Configura orario: `/morning_time 08:30`
- Attiva/disattiva: `/morning_on` e `/morning_off`
- Test immediato: `/morning_now`
- Simulazione domani: `/morning_tomorrow`
- Verifica task Google: `/gtasks_now`
- Se mail/task Google non compaiono, ricollega Google con `/gcal` per autorizzare anche Gmail e Google Tasks.

Se vuoi usare solo il messaggio mattutino, `OPENAI_API_KEY` e opzionale.

## Note
- I dati utente minimi sono salvati in `data/state.json`.
- Funziona in polling. Per webhook, possiamo aggiungerlo dopo.
