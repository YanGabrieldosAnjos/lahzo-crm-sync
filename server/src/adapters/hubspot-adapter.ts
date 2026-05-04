import type { CrmAdapter, ParsedEvent } from "./crm-adapter.js";
import type { HubSpotContact } from "@lahzo/shared";
import { verifyHubSpotSignature } from "../hubspot/signature.js";
import { HubSpotClient } from "../hubspot/client.js";

/**
 * HubSpot implementation of CrmAdapter.
 * Thin wrapper — real logic lives in hubspot/client.ts and signature.ts.
 */
export class HubSpotAdapter implements CrmAdapter {
  constructor(
    private readonly client: HubSpotClient,
    private readonly webhookSecret: string,
    private readonly publicBaseUrl: string,
  ) {}

  verifySignature(
    method: string,
    fullUrl: string,
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): void {
    verifyHubSpotSignature(
      method,
      fullUrl,
      rawBody,
      headers["x-hubspot-signature-v3"] as string | undefined,
      headers["x-hubspot-request-timestamp"] as string | undefined,
      this.webhookSecret,
    );
  }

  parseEvents(rawBody: string): ParsedEvent[] {
    const payload = JSON.parse(rawBody) as Array<{
      eventId: number;
      objectId: number;
      occurredAt: number;
      subscriptionType: string;
    }>;

    return payload.map((e) => ({
      eventId: String(e.eventId),
      objectId: String(e.objectId),
      occurredAt: new Date(e.occurredAt),
      eventType: e.subscriptionType,
      raw: e,
    }));
  }

  getContact(crmId: string, internalContactId?: string): Promise<HubSpotContact> {
    return this.client.getContact(crmId, internalContactId);
  }

  updateContactProperties(
    crmId: string,
    properties: Record<string, string>,
    internalContactId: string,
  ): Promise<void> {
    return this.client.updateContactProperties(crmId, properties, internalContactId);
  }
}

/**
 * Sketch of how a Salesforce adapter would slot in.
 *
 * The constructor would accept a Salesforce OAuth token (refreshed via
 * the token endpoint) and a Salesforce instance URL. Everything else —
 * the webhook handler, worker, and retry logic — remains unchanged.
 *
 * export class SalesforceAdapter implements CrmAdapter {
 *   constructor(
 *     private readonly accessToken: string,
 *     private readonly instanceUrl: string,   // e.g. https://acme.my.salesforce.com
 *     private readonly db: Db,
 *   ) {}
 *
 *   verifySignature(...): void {
 *     // Salesforce doesn't sign webhook bodies the same way.
 *     // Outbound Messages use a self-signed cert; Platform Events carry
 *     // a session token. Validation logic goes here.
 *   }
 *
 *   parseEvents(rawBody: string): ParsedEvent[] {
 *     // Map Salesforce Change Data Capture or Platform Event payload
 *     // to ParsedEvent[]. CDC puts the record id in event.recordId;
 *     // occurredAt comes from event.commitTimestamp.
 *   }
 *
 *   async getContact(crmId: string): Promise<HubSpotContact> {
 *     // GET ${instanceUrl}/services/data/v60.0/sobjects/Contact/${crmId}
 *     // Map Salesforce Lead/Contact fields to HubSpotContact shape,
 *     // or (better) define a CRM-neutral ContactData type.
 *   }
 *
 *   async updateContactProperties(...): Promise<void> {
 *     // PATCH ${instanceUrl}/services/data/v60.0/sobjects/Contact/${crmId}
 *     // with { lahzo_score__c, lahzo_status__c } custom fields.
 *   }
 * }
 */
