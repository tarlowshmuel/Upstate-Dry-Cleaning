# Deploying Upstate Dry Cleaning off Replit

This guide moves the app to a cheaper stack:

| Piece | Host | Cost |
|---|---|---|
| Customer pages + admin dashboard (static) | Cloudflare Pages | $0 |
| API server + Twilio webhook (always-on) | Fly.io | ~$2–5/mo |
| Postgres database | Neon | $0 |
| SMS phone number | Twilio (unchanged) | per-message |

Total monthly floor: roughly **$3–5/mo** plus your existing Twilio bill.

> The API host **must be always-on** — Twilio's webhook times out on sleeping
> free tiers, so SMS replies silently fail. Don't use Render's free tier for
> the API.

---

## 0. Prerequisites

- A copy of this repo cloned locally with `pnpm` and `node 24` installed.
- `pg_dump` / `pg_restore` on your machine (comes with the Postgres client).
- A credit card on Twilio and Fly (Neon + Cloudflare Pages don't require one for free tiers).

---

## 1. Create the new database (Neon)

1. Sign up: <https://console.neon.tech/signup>
2. Create a project → it gives you a connection string like
   `postgres://user:pwd@ep-xxx.neon.tech/neondb?sslmode=require`.
3. Save that string — you'll use it as `DATABASE_URL`.

Push the schema to the new database:

```bash
export DATABASE_URL='postgres://...neon.tech/...?sslmode=require'
pnpm --filter @workspace/db run push
```

Copy your current Replit data over (run from your local machine; get
`OLD_DATABASE_URL` from Replit's Database tab):

```bash
pg_dump --no-owner --no-acl --clean --if-exists "$OLD_DATABASE_URL" \
  | psql "$DATABASE_URL"
```

Verify with `psql "$DATABASE_URL" -c '\dt'` — you should see `orders`,
`order_line_items`, `price_list`, etc.

---

## 2. Deploy the API (Fly.io)

1. Install flyctl: <https://fly.io/docs/hands-on/install-flyctl/>
2. Sign in: `fly auth login` (opens browser).
3. From the repo root, create the app **without** deploying yet:

   ```bash
   fly launch --no-deploy --copy-config=false --name upstate-api
   ```

   When prompted, pick a region close to your customers (e.g. `ewr` for
   New York). It'll generate a `fly.toml` — open it and confirm
   `internal_port = 8080` and that there's no `[http_service.auto_stop_machines]`
   set to `stop` (we want always-on). A minimal config looks like:

   ```toml
   app = "upstate-api"
   primary_region = "ewr"

   [build]
     dockerfile = "Dockerfile"

   [http_service]
     internal_port = 8080
     force_https = true
     auto_start_machines = true
     auto_stop_machines = false
     min_machines_running = 1

   [[vm]]
     size = "shared-cpu-1x"
     memory = "256mb"
   ```

4. Set every secret (one-time):

   ```bash
   fly secrets set \
     DATABASE_URL='postgres://...neon.tech/...' \
     SESSION_SECRET='...' \
     ADMIN_PASSWORD='...' \
     ADMIN_PHONE_NUMBER='+1...' \
     TWILIO_ACCOUNT_SID='AC...' \
     TWILIO_AUTH_TOKEN='...' \
     TWILIO_PHONE_NUMBER='+1...' \
     DRIVER_START_ADDRESS='...' \
     DRY_CLEANERS_ADDRESS='...' \
     CORS_ORIGIN='https://upstate-dashboard.pages.dev'
   ```

   (You'll know the real CORS_ORIGIN after step 3. Set a placeholder now
   and update it after.)

5. Deploy:

   ```bash
   fly deploy
   ```

   When it finishes, your API is at `https://upstate-api.fly.dev`. Smoke test:

   ```bash
   curl https://upstate-api.fly.dev/api/customer/price-list
   ```

   You should get a JSON list of items back.

**Alternative host (Railway):** sign up at <https://railway.app>, create a
new project → "Deploy from GitHub repo", point it at the Dockerfile, paste
the same env vars in the Variables tab. Same shape, just a different UI.

---

## 3. Deploy the frontend (Cloudflare Pages)

The dashboard is a Vite static build.

1. Sign up: <https://dash.cloudflare.com/sign-up>
2. **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → pick
   your repo.
3. Build configuration:
   - **Framework preset:** None
   - **Build command:** `pnpm install --frozen-lockfile && pnpm --filter @workspace/dashboard run build`
   - **Build output directory:** `artifacts/dashboard/dist/public`
   - **Root directory:** leave blank (build runs from repo root)
   - **Environment variables (build-time):**
     - `VITE_API_BASE_URL` = `https://upstate-api.fly.dev` (from step 2)
     - `BASE_PATH` = `/`
     - `PORT` = `8080` _(the Vite config requires it even at build time)_
     - `NODE_VERSION` = `24`
4. **Save and Deploy.** Cloudflare gives you a URL like
   `https://upstate-dashboard.pages.dev`.

Now go back to step 2 and update `CORS_ORIGIN` on Fly to that URL:

```bash
fly secrets set CORS_ORIGIN='https://upstate-dashboard.pages.dev'
```

**Alternatives:** Vercel (<https://vercel.com/new>) and Netlify
(<https://app.netlify.com/start>) both work with the same settings.

---

## 4. Repoint Twilio to the new API

1. Twilio Console → **Phone Numbers → Manage → Active Numbers** →
   click your number.
2. Under **Messaging Configuration**, set:
   - **A message comes in** → Webhook →
     `https://upstate-api.fly.dev/api/twilio/sms` → HTTP POST
3. Save.

Twilio links:
- Numbers: <https://console.twilio.com/us1/develop/phone-numbers/manage/incoming>
- Auth credentials: <https://console.twilio.com/us1/account/keys-credentials/api-keys>

**Smoke test:** text your dry cleaning number from your phone with `MENU`
(or whatever your customer keyword is). You should get the same reply
you got on Replit. Watch `fly logs` in another terminal to see the
webhook arrive.

> If you get 403 from Twilio's signature check, double-check that the
> webhook URL in Twilio **exactly** matches the public URL Fly serves
> (https, no trailing slash, `/api/twilio/sms`).

---

## 5. Custom domains (optional but recommended)

- **API:** Fly → your app → Certificates → add `api.yourdomain.com`. Update
  the Twilio webhook to the new URL.
- **Dashboard:** Cloudflare Pages → your project → Custom domains → add
  `app.yourdomain.com`. Update `CORS_ORIGIN` on Fly to match.

---

## 6. Shut down Replit (only after SMS works on the new stack)

In this order:

1. Text the number — confirm replies come from the new Fly API. Watch
   `fly logs` to be sure.
2. Replit workspace → **Deployments** tab → **Stop** the deployment.
3. Replit workspace → **Database** tab → delete the Replit Postgres.
4. Replit account → **Plan / Billing** → downgrade to free or cancel.
5. Anything billing-related (refunds, prorated charges, etc.) goes
   through Replit support — not me.

---

## Quick reference — required environment

See `.env.example` for the full list with comments. The minimum to boot
the API is `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_PASSWORD`,
`ADMIN_PHONE_NUMBER`, the three `TWILIO_*` vars, `DRIVER_START_ADDRESS`,
and `DRY_CLEANERS_ADDRESS`.
