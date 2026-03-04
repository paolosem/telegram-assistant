# Regia OS - Setup Morning su Cloud (Render)

Questa guida serve per ricevere il messaggio mattutino su Telegram anche con PC spento.

## 1) Prerequisiti
- Account GitHub
- Account Render
- Git installato su Windows: https://git-scm.com/download/win

## 2) Pubblica il progetto su GitHub
Apri PowerShell e lancia:

```powershell
cd "C:\Users\Paolo\Desktop\paolo-personale\telegram-assistant"
git init
git add .
git commit -m "cloud morning setup"
git branch -M main
git remote add origin https://github.com/<TUO-USERNAME>/<NOME-REPO>.git
git push -u origin main
```

## 3) Deploy su Render
1. Vai su https://render.com
2. `New` -> `Web Service`
3. Seleziona il repo GitHub
4. Imposta:
   - **Root Directory**: `.`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `starter` (consigliato per always-on)

## 4) Environment Variables su Render
Aggiungi queste variabili:

- `TELEGRAM_BOT_TOKEN`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI=https://<nome-servizio>.onrender.com/oauth2callback`
- `APP_BASE_URL=https://<nome-servizio>.onrender.com`

Opzionali:
- `OPENAI_API_KEY` (non serve per il morning)
- `OPENAI_MODEL=gpt-4o-mini`

## 5) Google Cloud OAuth
Nel progetto Google Cloud:
1. Vai su `API e servizi` -> `Credenziali`
2. Apri il tuo OAuth Client
3. In **Authorized redirect URIs** aggiungi:

`https://<nome-servizio>.onrender.com/oauth2callback`

4. In **Utenti di test** assicurati che ci sia il tuo account lavoro.

## 6) Collega Google dal bot cloud
Su Telegram:

1. `/gcal`
2. Autorizza con account lavoro
3. `/morning_time 08:30`
4. `/morning_on`
5. `/morning_now` (test immediato)

## 7) Test finale
Se ricevi il messaggio da `/morning_now`, il setup e pronto.
Il morning automatico arrivera all'orario impostato.
