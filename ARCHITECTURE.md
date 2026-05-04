# Architecture & Design

## System architecture

```
HubSpot CRM
    │
    │  POST /webhooks/hubspot  (batched events, signed)
    ▼
┌─────────────────────────────────────────────────────┐
│  Express server  (:3000)                            │
│                                                     │
│  1. Verify X-HubSpot-Signature-v3                   │
│  2. Validate payload (zod)                          │
│  3. Per event, in one DB transaction:               │
│     - INSERT sync_events ON CONFLICT DO NOTHING     │  ← idempotency
│     - UPSERT contacts (ensure FK exists)            │
│     - INSERT jobs                                   │
│  4. Return 200  ← before DB writes complete         │
└────────────────────┬────────────────────────────────┘
                     │  Postgres (shared pool)
┌────────────────────▼────────────────────────────────┐
│  Worker process                                     │
│                                                     │
│  loop:                                              │
│    SELECT FROM jobs FOR UPDATE SKIP LOCKED          │  ← safe multi-worker
│    → stale-update check                             │  ← ordering protection
│    → GET /crm/v3/objects/contacts/:id               │  ← always fresh data
│    → sleep 3–15s  (simulated enrichment)            │
│    → compute score                                  │
│    → UPDATE contacts locally                        │
│    → PATCH lahzo_score + lahzo_status → HubSpot     │  ← writeback
│    → mark job done / retry / failed                 │
└─────────────────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────┐
│  React operator UI  (:5173)                         │
│                                                     │
│  GET /api/contacts          — paginated list        │
│  GET /api/contacts/:id      — detail + timeline     │
│  POST /api/contacts/:id/resync — manual re-trigger  │
└─────────────────────────────────────────────────────┘
```

## CRM choice: HubSpot, Private App

**Why HubSpot?** Free developer test account, no credit card, no trial expiry. A production-grade webhook + REST API that mirrors real client integrations.

**Why Private App (not OAuth dev app)?** For a single-account integration the Private App token is a stable bearer token — no OAuth flow, no token refresh, no callback URL. The architecture document explains how this becomes per-tenant OAuth at scale.

**What changes at production scale:** each client gets their own OAuth access token, refreshed transparently. The `HubSpotClient` would accept a `getToken: () => Promise<string>` callback instead of a static string. The rest of the system is unchanged.

## How we handle the short webhook timeout

HubSpot's effective timeout is ~5s. Our handler does the minimum work before returning 200:

1. Verify the HMAC signature (pure CPU, <1ms)
2. Parse and validate the JSON payload (pure CPU, <1ms)
3. Transactional DB insert (single round-trip, <50ms on local network)
4. **Return 200**

Enrichment, scoring, and HubSpot API calls happen asynchronously in the worker. If the worker crashes or is slow, HubSpot's delivery retries are handled by the `ON CONFLICT DO NOTHING` idempotency — no event is ever processed twice.

## How we decouple event ingestion from processing

The `jobs` table is the queue. The webhook handler is the producer; the worker is the consumer. They share only a Postgres connection pool — no message broker, no shared in-memory state.

The handler writes a `jobs` row synchronously (inside the ingest transaction). The worker polls with `SELECT ... FOR UPDATE SKIP LOCKED`. If the worker is stopped, jobs accumulate as `pending` rows — nothing is lost.

## How we prevent duplicate processing (idempotency)

Two layers:

1. **`sync_events.event_id` UNIQUE constraint.** HubSpot's `eventId` is the dedup key. The handler uses `INSERT ... ON CONFLICT (event_id) DO NOTHING RETURNING id`. If the returned row is empty, the event was a duplicate — no job is inserted.

2. **Database transaction.** The `sync_events` insert and the `jobs` insert are in one transaction. If the process crashes between them, the next delivery re-runs the whole transaction cleanly — the idempotency key prevents a second `sync_events` row, and therefore no second job.

## How we handle out-of-order events (stale update protection)

Each job carries `event_occurred_at` — the CRM-reported time of the change. When the worker picks up a job, it compares `job.event_occurred_at` against `contact.last_event_at`:

```
if (job.eventOccurredAt <= contact.lastEventAt) → mark skipped_stale, return
```

`contact.last_event_at` is only updated on **successful processing** (not on ingest). This means: if event T+5 is processed first, events T+1 through T+4 that arrive later are all skipped — they would overwrite newer data with older.

## How we ensure events are not lost on failure

Events are written to `sync_events` (durable Postgres) before we return 200 to HubSpot. Jobs stay in `pending` status until the worker successfully processes them. If the worker crashes mid-job, the job remains in `running` status. A periodic sweep reclaims jobs whose `locked_at` is older than `WORKER_STALE_LOCK_TIMEOUT_MS` (default 5 min), resetting them to `pending`. On exhausting `MAX_ATTEMPTS`, the job moves to `failed` — visible in the operator UI for manual re-trigger.

## How we handle CRM API rate limits and transient failures

The `HubSpotClient` wraps every outbound call with:

1. **Token bucket** (`limiter.ts`) — 100 tokens / 10s (configurable). Callers `await limiter.take()` before each request; calls queue up and are metered naturally.
2. **429 Retry-After** — HubSpot returns a `Retry-After` header on rate-limit responses. We parse it (`parseRetryAfterMs`) and sleep exactly that long before retrying.
3. **5xx / network errors** — exponential backoff with ±20% jitter (250ms → 500ms → 1s → 2s → 4s cap). Jitter prevents thundering-herd retries when multiple jobs were rate-limited simultaneously.
4. **Audit log** — every attempt (success or failure) writes one row to `api_calls`, so the operator can see exactly how many retries a call required and what responses came back.

## Schema mapping: HubSpot fields → internal model

| HubSpot field | Our field | Notes |
|---|---|---|
| `id` | `contacts.crm_id` | HubSpot's native object id |
| `properties.email` | `contacts.email` | `null` if not set |
| `properties.firstname` | `contacts.first_name` | HubSpot uses no camelCase |
| `properties.lastname` | `contacts.last_name` | |
| `properties.lahzo_score` | `contacts.score` | string → float on read |
| `properties.lahzo_status` | `contacts.status` | string → SyncStatus union on read |
| `eventId` (webhook) | `sync_events.event_id` | number → string (dedup key) |
| `objectId` (webhook) | `sync_events.crm_object_id` | number → string |
| `occurredAt` (webhook) | `sync_events.occurred_at` | epoch ms → timestamptz |
| `subscriptionType` (webhook) | `sync_events.event_type` | |

Mapping logic is isolated in `server/src/hubspot/mapping.ts`. The `Mapping` class is the only file that knows HubSpot's property naming conventions. Everything else uses our internal field names.

## Data modeling decisions

**Four tables, each with a single responsibility:**

- `contacts` — current state of each contact. Rolling updates. One row per CRM identity.
- `sync_events` — append-only inbound log. Never updated after insert. The UNIQUE constraint on `event_id` is the idempotency anchor.
- `jobs` — worker queue. Rows transition: `pending → running → done/failed`. Retries increment `attempts` and bump `next_run_at`.
- `api_calls` — append-only outbound audit log. One row per attempt, never updated.

**Contact identity is `(crm_source, crm_id)`**, not just `crm_id`. This allows a future Salesforce adapter to coexist with HubSpot contacts in the same table without id collisions.

**Statuses are `text` columns, not `pgEnum`.** Adding a new status value requires no `ALTER TYPE` migration — just a new option in the TypeScript union. The tradeoff is that invalid values aren't caught at the DB layer; Zod validates them at the API boundary instead.

**`contact.last_event_at` is owned by the worker**, not the webhook handler. The handler sets it to `now()` on first insert (placeholder), but only the worker sets it to `job.event_occurred_at` on successful processing. This is what makes stale-update protection work correctly.

## Tradeoffs

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Queue | Postgres `SKIP LOCKED` | Redis / BullMQ | Zero extra infra. Transactional with the rest of the data. Works up to ~thousands of jobs/min. Redis wins at very high volume or when you want DLQ, priority queues, and distributed workers as first-class concepts. |
| Auth | Private App (static token) | OAuth dev app | No OAuth flow to build or maintain. The architecture doc explains how to migrate to per-tenant OAuth for production. |
| Worker model | In-process polling | `pg LISTEN/NOTIFY` | Polling is predictable, debuggable, and has no connection-count issues. LISTEN/NOTIFY would give sub-second latency without polling CPU but requires a dedicated connection per worker. |
| DB driver | `pg` (node-postgres) | `postgres.js` | Wider ecosystem, battle-tested, straightforward transaction API. |
| ORM | Drizzle | Prisma | SQL-first, lightweight, no codegen step. Migrations are plain SQL files. |

## What would change for production scale (multiple clients, multiple CRMs)

1. **Per-tenant auth.** Replace the static `HUBSPOT_TOKEN` with a `tenants` table storing OAuth access/refresh tokens per client. `HubSpotClient` accepts `getToken: () => Promise<string>` instead of a string.

2. **Tenant isolation.** Add `tenant_id` FK to `contacts`, `sync_events`, `jobs`, and `api_calls`. All queries are scoped by tenant. Partition heavy tables (`sync_events`, `api_calls`) by `tenant_id` at high volume.

3. **Per-tenant rate limit buckets.** Each tenant gets their own `TokenBucket` instance keyed by their HubSpot app id. Exhausting one tenant's limit doesn't block others.

4. **Horizontal workers.** Multiple worker processes on separate machines all poll the same `jobs` table. `SKIP LOCKED` handles the concurrency correctly without any coordination layer.

5. **Multi-CRM via adapter interface.** `CrmAdapter` (`server/src/adapters/crm-adapter.ts`) defines the contract. New CRMs get a new adapter class. The webhook handler and worker receive an adapter instance — they're already written against the interface. See `docs/adapter-sketch.md` for detail.

6. **Observability.** Expose Prometheus metrics: `sync_lag_seconds` (job creation to done), `job_failure_rate`, `hubspot_api_latency_ms`, `jobs_pending_count`. Alert on DLQ depth (`status=failed`) and sync lag p95 exceeding SLA.

7. **Retention policy.** `sync_events` and `api_calls` grow unboundedly. Add a nightly job to archive or delete rows older than N days per tenant.
