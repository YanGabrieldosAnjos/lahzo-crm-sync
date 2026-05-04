# Multi-CRM adapter sketch

## The abstraction

`server/src/adapters/crm-adapter.ts` defines a `CrmAdapter` interface with four methods:

```ts
interface CrmAdapter {
  verifySignature(method, fullUrl, rawBody, headers): void;
  parseEvents(rawBody): ParsedEvent[];
  getContact(crmId, internalContactId?): Promise<HubSpotContact>;
  updateContactProperties(crmId, props, internalContactId): Promise<void>;
}
```

The webhook handler and worker are already written to accept any `CrmAdapter` implementation. Adding a second CRM means:

1. Implement the four methods in a new adapter class
2. Register the adapter on the right route (e.g. `POST /webhooks/salesforce`)
3. No changes to the handler, worker, schema, or UI

## Salesforce adapter (sketch)

```ts
export class SalesforceAdapter implements CrmAdapter {
  constructor(
    private readonly accessToken: string,
    private readonly instanceUrl: string,  // e.g. https://acme.my.salesforce.com
    private readonly db: Db,
  ) {}

  // Salesforce Platform Events carry a session token; CDC uses cert-based auth.
  // Outbound Messages from Apex triggers can be verified via the org's cert.
  verifySignature(method, fullUrl, rawBody, headers): void {
    // Implementation depends on chosen integration pattern.
    // For Apex callouts: verify a shared secret header.
    // For Platform Events: verify the connected app session.
  }

  parseEvents(rawBody: string): ParsedEvent[] {
    // Change Data Capture event shape:
    // {
    //   "data": {
    //     "schema": "...",
    //     "payload": {
    //       "ChangeEventHeader": {
    //         "entityName": "Contact",
    //         "recordIds": ["0031234567890"],
    //         "changeType": "UPDATE",
    //         "commitTimestamp": 1714732800000
    //       }
    //     },
    //     "event": { "replayId": 8 }
    //   }
    // }
    const body = JSON.parse(rawBody);
    const header = body.data.payload.ChangeEventHeader;
    return header.recordIds.map((id: string) => ({
      eventId: `sf_${body.data.event.replayId}_${id}`,  // dedup key
      objectId: id,
      occurredAt: new Date(header.commitTimestamp),
      eventType: `contact.${header.changeType.toLowerCase()}`,
      raw: body,
    }));
  }

  async getContact(crmId: string, internalContactId?: string): Promise<HubSpotContact> {
    // GET /services/data/v60.0/sobjects/Contact/:id
    const res = await fetch(
      `${this.instanceUrl}/services/data/v60.0/sobjects/Contact/${crmId}`,
      { headers: { Authorization: `Bearer ${this.accessToken}` } },
    );
    const sf = await res.json();

    // Map Salesforce fields to our shared HubSpotContact shape.
    // In a real system you'd define a CRM-neutral ContactData type instead.
    return {
      id: sf.Id,
      properties: {
        email: sf.Email,
        firstname: sf.FirstName,
        lastname: sf.LastName,
        lahzo_score: sf.Lahzo_Score__c ?? null,
        lahzo_status: sf.Lahzo_Status__c ?? null,
        createdate: sf.CreatedDate,
        lastmodifieddate: sf.LastModifiedDate,
      },
      createdAt: sf.CreatedDate,
      updatedAt: sf.LastModifiedDate,
      archived: false,
    };
  }

  async updateContactProperties(
    crmId: string,
    props: Record<string, string>,
    _internalContactId: string,
  ): Promise<void> {
    // PATCH /services/data/v60.0/sobjects/Contact/:id
    // Custom fields use the __c suffix in Salesforce.
    await fetch(
      `${this.instanceUrl}/services/data/v60.0/sobjects/Contact/${crmId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          Lahzo_Score__c: props.lahzo_score,
          Lahzo_Status__c: props.lahzo_status,
        }),
      },
    );
  }
}
```

## What doesn't change

| Layer | Changes needed |
|---|---|
| Webhook handler | Add a new route, pass `SalesforceAdapter` instead of `HubSpotAdapter` |
| Worker | None — calls `adapter.getContact()` + `adapter.updateContactProperties()` |
| Schema | None — `crm_source` column already handles multiple sources |
| Operator UI | None |
| Rate limiting / retries | None — lives inside each adapter's client |

## The one type friction point

`getContact` currently returns `HubSpotContact`. In a real multi-CRM system you'd define a **CRM-neutral `ContactData` type** that both adapters map to:

```ts
interface ContactData {
  crmId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  rawScore: string | null;   // CRM's stored score, as string
  rawStatus: string | null;  // CRM's stored status
}
```

Both `HubSpotAdapter.getContact()` and `SalesforceAdapter.getContact()` map to this, and the worker's `Mapping` class accepts `ContactData` instead of `HubSpotContact`. That's the natural next refactor once a second adapter exists.
