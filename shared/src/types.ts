/**
 * Wire types shared between server and client. These also define the
 * contract a CRM adapter (HubSpot, Salesforce, ...) must produce.
 *
 * All timestamps are ISO 8601 strings on the wire — the server hands out
 * stringified Postgres timestamps and the client treats them as opaque.
 */

export type CrmSource = "hubspot" | "salesforce" | "mock";

/**
 * Contact-level lifecycle visible to the operator.
 * - received:      ingested, awaiting worker
 * - processing:    worker picked it up, enriching/scoring
 * - synced:        last writeback to the CRM succeeded
 * - failed:        retries exhausted, see lastError
 * - skipped_stale: a newer event already won, this one was discarded
 */
export type SyncStatus =
  | "received"
  | "processing"
  | "synced"
  | "failed"
  | "skipped_stale";

/**
 * Worker-internal job state, decoupled from contact-facing SyncStatus
 * because a single contact may have many jobs over time.
 */
export type JobStatus = "pending" | "running" | "done" | "failed";

export type EventType =
  | "contact.creation"
  | "contact.propertyChange"
  | "contact.deletion"
  | "manual.resync";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface Contact {
  id: string;
  crmSource: CrmSource;
  crmId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  score: number | null;
  status: SyncStatus;
  lastEventAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncEvent {
  id: string;
  crmSource: CrmSource;
  /** Dedup key. UNIQUE constraint enforces idempotency on inbound. */
  eventId: string;
  crmObjectId: string;
  eventType: EventType;
  occurredAt: string;
  receivedAt: string;
  payload: unknown;
}

export interface ApiCall {
  id: string;
  contactId: string | null;
  direction: "outbound";
  method: HttpMethod;
  url: string;
  requestBody: unknown | null;
  responseStatus: number | null;
  responseBody: unknown | null;
  attempt: number;
  latencyMs: number;
  error: string | null;
  createdAt: string;
}

export interface Job {
  id: string;
  contactId: string;
  syncEventId: string;
  /** The CRM-reported event time. Used for stale-update protection. */
  eventOccurredAt: string;
  status: JobStatus;
  attempts: number;
  nextRunAt: string;
  lastError: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Unified timeline item the operator UI renders. Inbound events and
 * outbound API calls are merged server-side and sorted by timestamp.
 */
export type TimelineItem =
  | { kind: "event"; at: string; event: SyncEvent }
  | { kind: "api_call"; at: string; call: ApiCall };

export interface ContactDetail {
  contact: Contact;
  timeline: TimelineItem[];
}

export interface ContactListItem {
  id: string;
  crmSource: CrmSource;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  score: number | null;
  status: SyncStatus;
  lastEventAt: string;
  lastError: string | null;
}

export interface ContactListResponse {
  items: ContactListItem[];
  nextCursor: string | null;
}

export interface HubSpotContact {
  id: string;
  properties: {
    email: string | null;
    firstname: string | null;
    lastname: string | null;
    lahzo_score: string | null;
    lahzo_status: string | null;
    createdate: string | null;
    lastmodifieddate: string | null;
    // HubSpot can return extra properties — index signature covers them
    [key: string]: string | null;
  };
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}