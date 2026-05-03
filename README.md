# Lahzo CRM Sync

An integration service that bridges a customer-facing platform and a CRM (HubSpot). When a Contact is created or updated in HubSpot, an event flows into this service, gets processed asynchronously (simulated enrichment + scoring), and the result is pushed back to HubSpot as custom properties (`lahzo_score`, `lahzo_status`).

An operator UI shows sync history per Contact and allows manual re-sync.

> Status: scaffolding. See [the implementation plan](../../.claude/plans/senior-client-integration-engineer-fancy-dawn.md) for the full step-by-step build.

## Layout

```
shared/   # types shared between server and client
server/   # Express API + worker, Drizzle ORM, Postgres
client/   # React + Vite operator UI
docs/     # HubSpot setup, multi-CRM adapter sketch
```

## Quick start

```bash
# 1. Postgres
docker compose up -d postgres

# 2. Env
cp .env.example .env
# fill HUBSPOT_TOKEN and HUBSPOT_WEBHOOK_SECRET (see docs/hubspot-setup.md)

# 3. Install + migrate + bootstrap HubSpot custom properties
npm install
npm run db:migrate
npm run hubspot:bootstrap

# 4. Run (each in its own terminal)
npm run dev:server
npm run dev:worker
npm run dev:client

# 5. Expose webhook
ngrok http 3000
# point HubSpot webhook target at <ngrok-url>/webhooks/hubspot
```

See [docs/hubspot-setup.md](docs/hubspot-setup.md) for the full setup walkthrough and [ARCHITECTURE.md](ARCHITECTURE.md) for design decisions.
