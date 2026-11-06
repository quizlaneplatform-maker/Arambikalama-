# Deploying Aarambikallama

Aarambikallama is one Node.js process that serves the website, the API and the live-game WebSockets. It stores its data as JSON files. That shapes where it can run:

| Needs | Why |
|---|---|
| A **long-running server** (not "serverless") | Live games use WebSockets and keep game state in memory |
| A **persistent disk** | Users, quizzes, reports and sessions are files in `DATA_DIR` |
| **Exactly 1 instance** | Games, login codes and rate limits live in that one process; 2+ instances would split them |
| **HTTPS** | Login cookies are marked `Secure` in production |

✅ Works on: **Render** (web service + disk), **Railway** (service + volume), **Fly.io** (app + volume), or any **VPS** (DigitalOcean, Lightsail, Hetzner…).
❌ Won't work on: Vercel, Netlify, GitHub Pages, Firebase Hosting (no WebSockets or disk).

---

## Step 0: Before you deploy

1. **Email for login codes.** Required in production; the app refuses to start without it. Get an SMTP login: a Gmail App Password works (see "Email setup" below).
2. **Grok key (optional).** Get a working key from https://console.x.ai. The current key in `.env` was rejected by xAI during testing. With no key, the app runs fine and the AI panel just says it's off.
3. **Put the code on GitHub** (Render and Railway deploy from a repo):
   ```bash
   git init
   git add .
   git commit -m "Aarambikallama"
   # create an empty repo on github.com, then:
   git remote add origin https://github.com/<you>/aarambikallama.git
   git branch -M main
   git push -u origin main
   ```
   `.gitignore` already keeps out `.env` (your keys), `data/` (local test accounts), `node_modules/`, the test reports and the design `.rar`. Check with `git status` before the first commit that `.env` is **not** listed.

---

## Option A: Render (easiest)

**Fastest:** Dashboard → **New → Blueprint** → pick this repo. `render.yaml` fills in everything below; you only type `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` and `XAI_API_KEY`. Or do it by hand:

1. https://dashboard.render.com → **New → Web Service** → connect your GitHub repo.
2. Settings:
   | Field | Value |
   |---|---|
   | Runtime | Node |
   | Build command | `npm ci` |
   | Start command | `npm start` |
   | Instance type | a **paid** instance (free instances can't have a disk and sleep when idle) |
   | Health check path | `/healthz` |
3. **Disks** → Add disk: mount path `/data`, size 1 GB.
4. **Environment** → add these variables:
   ```
   NODE_ENV=production
   DATA_DIR=/data
   NODE_VERSION=22
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=yourname@gmail.com
   SMTP_PASS=your16charapppassword
   MAIL_FROM=Aarambikallama <yourname@gmail.com>
   XAI_API_KEY=xai-...          (optional)
   ```
5. **Create Web Service.** In the deploy log, look for:
   ```
   Aarambikallama running at http://localhost:10000
     Login codes: emailed via smtp.gmail.com as yourname@gmail.com
   ```
6. Your app is live at `https://<name>.onrender.com`. Keep the instance count at **1** (no autoscaling).

## Option B: Railway

1. https://railway.app → **New Project → Deploy from GitHub repo**.
2. Service → **Settings**: start command `npm start`, healthcheck path `/healthz`, replicas **1**.
3. Right-click the service → **Attach volume** → mount path `/data`.
4. **Variables:** the same list as Render step 4 (Railway sets `PORT` itself).
5. **Settings → Networking → Generate Domain** to get an `https://….up.railway.app` address.

## Option C: Your own server (VPS)

On Ubuntu with Node 22 installed:

```bash
git clone https://github.com/<you>/aarambikallama.git /opt/aarambikallama
cd /opt/aarambikallama && npm ci --omit=dev
sudo mkdir -p /var/lib/aarambikallama && sudo chown $USER /var/lib/aarambikallama
cp .env.example .env   # fill in SMTP_*, XAI_API_KEY, then add:
#   NODE_ENV=production
#   DATA_DIR=/var/lib/aarambikallama
```

Keep it running with **pm2**:
```bash
sudo npm i -g pm2
pm2 start npm --name aarambikallama -- start
pm2 save && pm2 startup     # restart on reboot
```

HTTPS with **Caddy** (gets a free certificate automatically). Point your domain's DNS A record at the server, then put this in `/etc/caddy/Caddyfile`:
```
quiz.yourschool.org {
    reverse_proxy localhost:3000
}
```
`sudo systemctl reload caddy`. Caddy forwards WebSockets automatically.

---

## Step 2: Check it after deploying (5 minutes)

1. `https://<your-app>/healthz` → `{"ok":true}`
2. Log in with **your real email**. The 6-digit code should arrive within seconds (check spam the first time). The first time, you'll be asked for your name.
3. Create a quiz and click **Host live**. On your phone (mobile data, not Wi-Fi), open the site, enter the code and answer. If the answer appears on the host screen, WebSockets work.
4. End the game and open the report.
5. **Redeploy** (or restart) and log in again. If your quiz and report are still there, the disk is set up correctly.

---

## Email setup

**On Render's free plan, Gmail will not work.** Since September 2025, Render's free web services block outgoing traffic on the SMTP ports (25, 465, 587), so login codes never arrive and the log shows a timeout. Use Brevo, which sends over HTTPS, or upgrade the service to a paid instance.

### Brevo (works on any host, free for 300 emails a day)

1. Sign up at https://www.brevo.com (free plan).
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender** with your Gmail address, then click the link Brevo emails you. No domain needed.
3. https://app.brevo.com/settings/keys/api → **Generate a new API key** → copy it.
4. On Render → your service → **Environment**, set:
   ```
   BREVO_API_KEY=xkeysib-...
   MAIL_FROM=Aarambikallama <the-sender-you-verified@gmail.com>
   ```
   Save. Render redeploys. The log should then say `Login codes: emailed via Brevo`.

When `BREVO_API_KEY` is set it is used instead of the SMTP settings, so you can leave `SMTP_*` in place.

### Gmail (SMTP: paid hosts, or running on your own computer)

1. https://myaccount.google.com/security → turn on **2-Step Verification**.
2. https://myaccount.google.com/apppasswords → create one named "Aarambikallama" → copy the 16 characters (no spaces).
3. Use it as `SMTP_PASS`, with `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465` and `SMTP_USER` = that Gmail address.

Other providers: Outlook `smtp-mail.outlook.com:587`, Yahoo `smtp.mail.yahoo.com:465`, Brevo `smtp-relay.brevo.com:587`. Gmail sends about 500 emails a day. For a whole school, use a sending service such as Brevo, Resend or SendGrid.

---

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV` | ✅ `production` | Secure cookies, HSTS, trusts the host's proxy, requires email |
| `DATA_DIR` | ✅ | Path on the persistent disk, e.g. `/data`. If it can't be written (a Render free instance has no disk), the app falls back to a temporary folder and logs a warning; accounts and quizzes are then lost on every redeploy or restart |
| `BREVO_API_KEY` | ✅ one of these two | Email for login codes over HTTPS (needed on Render's free plan) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | ✅ one of these two | Email for login codes over SMTP |
| `MAIL_FROM` | recommended | Sender shown in the inbox, e.g. `Aarambikallama <you@gmail.com>` |
| `XAI_API_KEY` | optional | Turns on AI question generation |
| `XAI_MODEL` | optional | Grok model (default `grok-4.7`) |
| `PORT` | set by host | Port to listen on (default 3000) |
| `TRUST_PROXY` | optional | Proxies in front of the app (default 1 in production) |
| `ALLOW_CONSOLE_OTP` | demo only | `true` = run without email; codes appear in the server logs |

---

## Keeping it healthy

- **Backups:** copy the `DATA_DIR` folder regularly (users, quizzes, reports, sessions). On Render or Railway, download it from the disk/volume; on a VPS, use a daily `cron` + `tar`.
- **Updates:** push to GitHub and the host redeploys. A restart ends games in progress, so deploy outside class time.
- **Logs:** the host's log view shows startup status (`Login codes: emailed via…`, `AI question generation: on/off`) and any errors.
- **Secrets:** never commit `.env`. If a key or password was ever shared or committed, revoke it and make a new one (xAI console, Google App Passwords).

## Known limits of this version

| Limit | Impact | Upgrade path |
|---|---|---|
| JSON-file storage | Fine for one school (hundreds of teachers); not for heavy concurrent use | Move `lib/store.js` to SQLite or PostgreSQL |
| One instance only | Up to 200 players per game; a few hundred live connections are fine | Redis for game state + Socket.IO Redis adapter |
| Restart ends live games | Teachers would need to restart a running game | Persist game state |
| No Content-Security-Policy | Small extra hardening missing | Move inline `<script>`s into `.js` files, then add a CSP |
| White text on magenta buttons is 3.39:1 | Below WCAG AA for small text | Darker accent, or pick another theme |
