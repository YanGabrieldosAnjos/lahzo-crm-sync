import type { HubSpotContact } from "@lahzo/shared";

/**
 * Contract every CRM adapter must satisfy.
 *
 * The webhook handler and worker are programmed against this interface,
 * not against HubSpot's API directly. Swapping in a Salesforce adapter
 * means implementing these four methods — no other file changes.
 */
export interface CrmAdapter {
  /**
   * Verify the inbound webhook request signature.
   * Throws if the signature is invalid or the request is replayed.
   */
  verifySignature(
    method: string,
    fullUrl: string,
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): void;

  /**
   * Parse the raw webhook body into a normalised list of events.
   * Each event carries the minimum needed for ingestion:
   * objectId, occurredAt, eventType, and a dedup key (eventId).
   */
  parseEvents(rawBody: string): ParsedEvent[];

  /**
   * Fetch the current full state of a contact by the CRM's native id.
   * `internalContactId` is our UUID — pass it so the adapter can write
   * an api_calls audit row tied to the right contact.
   */
  getContact(
    crmId: string,
    internalContactId?: string,
  ): Promise<HubSpotContact>;

  /**
   * Push computed properties back to the CRM contact.
   */
  updateContactProperties(
    crmId: string,
    properties: Record<string, string>,
    internalContactId: string,
  ): Promise<void>;
}

/** Normalised event — what the webhook handler stores, regardless of CRM. */
export interface ParsedEvent {
  /** Globally unique delivery id. Used as the idempotency key. */
  eventId: string;
  /** CRM's native object id (contact / lead). */
  objectId: string;
  /** ISO 8601 timestamp from the CRM. Drives stale-update protection. */
  occurredAt: Date;
  /** Normalised event type, e.g. "contact.creation". */
  eventType: string;
  /** Raw payload preserved for audit. */
  raw: unknown;
}
