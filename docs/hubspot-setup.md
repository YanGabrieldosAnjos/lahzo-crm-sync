# HubSpot setup

This walks through everything you need to run the integration against a real HubSpot account end-to-end. ~10 minutes.

## 1. Sign up for a free developer account

Go to <https://developers.hubspot.com> and create a developer account. No credit card, no trial expiry.

## 2. Create a developer test account

From the developer portal, create a **test account** ("App Test Account"). This is a sandboxed HubSpot CRM with Contacts/Companies/Deals — the place we'll create real data and watch our integration react.

> Why not a real HubSpot account? Test accounts give us a Pro-tier sandbox without paying, and they reset cleanly. Anything we do here is throwaway.

## 3. Create a Private App in the test account

Inside the test account: **Settings → Integrations → Private Apps → Create a private app**.

Fill in:

- **Name**: `Lahzo CRM Sync (dev)`
- **Scopes** (Scopes tab):
  - `crm.objects.contacts.read`
  - `crm.objects.contacts.write`
  - `crm.schemas.contacts.write` (needed to create the custom properties in step 5)
- **Webhooks** (Webhooks tab — see step 4)

Click **Create app**. On the next screen click **Show token** and copy the bearer token (starts with `pat-na1-…`). This is your `HUBSPOT_TOKEN`.

## 4. Configure webhooks on the Private App

Still in the Private App, open the **Webhooks** tab.

- **Target URL**: your public webhook endpoint. In dev, this is your ngrok URL plus `/webhooks/hubspot`, e.g. `https://abc123.ngrok-free.app/webhooks/hubspot`.
- **Subscriptions**: subscribe to:
  - `contact.creation`
  - `contact.propertyChange` — when prompted for which properties, pick `email`, `firstname`, `lastname` (anything we mirror locally).

Save. HubSpot will show a **Client secret** for webhook signing on this same page — copy it into `.env` as `HUBSPOT_WEBHOOK_SECRET`. This is what we HMAC the request body with to verify the `X-HubSpot-Signature-v3` header.

> **If your test account doesn't expose webhooks on Private Apps:** fall back to a Developer App. Create one from the developer portal, configure the same subscriptions there, install it on the test account via OAuth. The signature scheme (v3) and the rest of the flow stay identical — only the auth changes from a static bearer token to an OAuth access token. Our adapter abstraction (see [adapter-sketch.md](adapter-sketch.md)) keeps the swap small.

## 5. Bootstrap the custom properties

The integration writes back two custom properties on each Contact:

| Property | Type | Purpose |
|---|---|---|
| `lahzo_score` | number | Result of our enrichment + scoring step |
| `lahzo_status` | enumeration | `received` / `processing` / `synced` / `failed` / `skipped_stale` |

Rather than clicking through the HubSpot UI, run:

```bash
npm run hubspot:bootstrap
```

This script reads `HUBSPOT_TOKEN` from `.env` and creates the two properties via the CRM v3 properties API. It's idempotent — if a property already exists, it logs and moves on.

## 6. Expose your local server

In a separate terminal:

```bash
ngrok http 3000
# or: cloudflared tunnel --url http://localhost:3000
```

Copy the HTTPS URL ngrok prints and paste it into the **Target URL** field of the Private App's Webhooks tab (step 4) followed by `/webhooks/hubspot`. Save.

> Tip: `ngrok` URLs change every time the process restarts (on the free tier). If you restart ngrok, update the target URL in HubSpot.

## 7. Smoke test

1. `docker compose up -d postgres`
2. `npm run db:migrate && npm run hubspot:bootstrap`
3. Three terminals: `npm run dev:server`, `npm run dev:worker`, `npm run dev:client`
4. Fourth terminal: `ngrok http 3000`
5. In the HubSpot test account, create a Contact (any email).
6. Within a few seconds it should appear in the operator UI at <http://localhost:5173> with status `received`, then flip to `processing`, then `synced`.
7. Reload the contact in HubSpot and confirm `lahzo_score` and `lahzo_status` are populated.

## Reference

- [Webhooks v3 guide](https://developers.hubspot.com/docs/api-reference/latest/webhooks/guide)
- [CRM v3 contacts API](https://developers.hubspot.com/docs/api/crm/contacts)
- [CRM v3 properties API](https://developers.hubspot.com/docs/api/crm/properties)
- [Signature verification (v3)](https://developers.hubspot.com/docs/api/webhooks/validating-requests)
