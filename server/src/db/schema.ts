import {
  pgTable,
  uuid,
  text,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Contacts mirror the customer's CRM record. Identity is (crm_source, crm_id)
 * so the same internal id stays stable across webhook deliveries and is
 * portable when we add another CRM adapter.
 */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    crmSource: text("crm_source").notNull(),
    crmId: text("crm_id").notNull(),
    email: text("email"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    /** Result of the simulated enrichment + scoring step. Null until first sync. */
    score: doublePrecision("score"),
    /** SyncStatus union from @lahzo/shared. Stored as text + narrowed in TS. */
    status: text("status").notNull().default("received"),
    /** Latest event time we've applied. Drives stale-update protection. */
    lastEventAt: timestamp("last_event_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    crmIdentity: uniqueIndex("contacts_crm_identity_idx").on(
      t.crmSource,
      t.crmId,
    ),
    statusListIdx: index("contacts_status_last_event_idx").on(
      t.status,
      t.lastEventAt,
    ),
  }),
);

/**
 * Append-only log of every inbound CRM webhook event. The UNIQUE constraint
 * on event_id is the primary defense against duplicate webhook deliveries.
 */
export const syncEvents = pgTable(
  "sync_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    crmSource: text("crm_source").notNull(),
    /** Provider-supplied event id. UNIQUE — duplicates land in ON CONFLICT DO NOTHING. */
    eventId: text("event_id").notNull(),
    crmObjectId: text("crm_object_id").notNull(),
    eventType: text("event_type").notNull(),
    /** When the event happened in the CRM, per the provider. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    payload: jsonb("payload").notNull(),
  },
  (t) => ({
    eventIdUniq: uniqueIndex("sync_events_event_id_uniq").on(t.eventId),
    objectIdx: index("sync_events_object_idx").on(
      t.crmSource,
      t.crmObjectId,
      t.occurredAt,
    ),
  }),
);

/**
 * Append-only audit log of every outbound CRM API call (one row per attempt).
 * Lets the operator see exactly what we sent, what came back, and how many
 * retries it took. Never updated — every retry inserts a new row.
 */
export const apiCalls = pgTable(
  "api_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    direction: text("direction").notNull().default("outbound"),
    method: text("method").notNull(),
    url: text("url").notNull(),
    requestBody: jsonb("request_body"),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    /** 1-indexed retry counter for this logical operation. */
    attempt: integer("attempt").notNull().default(1),
    latencyMs: integer("latency_ms").notNull(),
    /** Set when the call never reached a response (network error, timeout). */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    contactTimelineIdx: index("api_calls_contact_created_idx").on(
      t.contactId,
      t.createdAt,
    ),
  }),
);

/**
 * Worker job queue. We poll with SELECT ... FOR UPDATE SKIP LOCKED so multiple
 * workers can run safely. event_occurred_at carries the CRM-reported time so
 * the worker can detect stale updates without re-reading the event row.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    syncEventId: uuid("sync_event_id")
      .notNull()
      .references(() => syncEvents.id, { onDelete: "cascade" }),
    eventOccurredAt: timestamp("event_occurred_at", {
      withTimezone: true,
    }).notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    /** Earliest time this job is eligible to run. Bumped by backoff on retry. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    /** Set when a worker picks the job; cleared on completion. */
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    /** hostname:pid of the worker that holds the lock. */
    lockedBy: text("locked_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    /** The hot path: pick the next runnable job. */
    pollIdx: index("jobs_poll_idx")
      .on(t.status, t.nextRunAt)
      .where(sql`${t.status} = 'pending'`),
    /** For the stale-lock sweep. */
    lockedAtIdx: index("jobs_locked_at_idx").on(t.lockedAt),
  }),
);

export type ContactRow = typeof contacts.$inferSelect;
export type NewContactRow = typeof contacts.$inferInsert;
export type SyncEventRow = typeof syncEvents.$inferSelect;
export type NewSyncEventRow = typeof syncEvents.$inferInsert;
export type ApiCallRow = typeof apiCalls.$inferSelect;
export type NewApiCallRow = typeof apiCalls.$inferInsert;
export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
