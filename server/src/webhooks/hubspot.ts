import type { RequestHandler } from "express";
import { z } from "zod";
import { verifyHubSpotSignature, SignatureError } from "../hubspot/signature.js";
import { db } from "../db/client.js";
import { contacts, syncEvents, jobs } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Payload validation 
// ---------------------------------------------------------------------------

const hubSpotEventSchema = z.object({
  eventId: z.number(),
  subscriptionId: z.number(),
  portalId: z.number(),
  appId: z.number(),
  occurredAt: z.number(),
  subscriptionType: z.string(),
  attemptNumber: z.number(),
  objectId: z.number(),
  changeSource: z.string().optional(),
  propertyName: z.string().optional(),
  propertyValue: z.string().optional(),
});

const hubSpotPayloadSchema = z.array(hubSpotEventSchema);

type HubSpotWebhookEvent = z.infer<typeof hubSpotEventSchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const hubspotWebhookHandler: RequestHandler = async (req, res) => {
  // 1. Verify signature — return 400 immediately if invalid or replayed
  const fullUrl = `${req.protocol}://${req.get("host")}${req.path}`;
  const rawBody = (req.body as Buffer).toString();

  try {
    verifyHubSpotSignature(
      req.method,
      fullUrl,
      rawBody,
      req.headers["x-hubspot-signature-v3"] as string | undefined,
      req.headers["x-hubspot-request-timestamp"] as string | undefined,
      process.env.HUBSPOT_WEBHOOK_SECRET!,
    );
  } catch (err) {
    if (err instanceof SignatureError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }

  // 2. Parse + validate — return 400 on malformed body
  const parsed = hubSpotPayloadSchema.safeParse(JSON.parse(rawBody));
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  // 3. Return 200 immediately — HubSpot has a ~5s timeout.
  // Processing happens below but the response is already sent.
  res.status(200).send();

  // 4. Ingest each event — one transaction per event so a single bad event
  //    doesn't roll back the entire batch.
  await Promise.allSettled(
    parsed.data.map((event: HubSpotWebhookEvent) =>
      db.transaction(async (tx) => {
        // Idempotency: UNIQUE(event_id) — duplicate deliveries silently no-op.
        const [inserted] = await tx
          .insert(syncEvents)
          .values({
            crmSource: "hubspot",
            eventId: String(event.eventId),
            crmObjectId: String(event.objectId),
            eventType: event.subscriptionType,
            occurredAt: new Date(event.occurredAt),
            payload: event,
          })
          .onConflictDoNothing()
          .returning({ id: syncEvents.id });

        // Duplicate delivery — nothing to do.
        if (!inserted) return;

        // Ensure the contact row exists so the jobs FK resolves.
        // On conflict: only update status + updatedAt — lastEventAt is owned by the worker.
        const [contact] = await tx
          .insert(contacts)
          .values({
            crmSource: "hubspot",
            crmId: String(event.objectId),
            status: "received",
            lastEventAt: new Date(event.occurredAt),
          })
          .onConflictDoUpdate({
            target: [contacts.crmSource, contacts.crmId],
            set: { status: "received", updatedAt: new Date() },
          })
          .returning({ id: contacts.id });

        // Enqueue the job — worker picks this up via SKIP LOCKED.
        await tx.insert(jobs).values({
          contactId: contact!.id,
          syncEventId: inserted.id,
          eventOccurredAt: new Date(event.occurredAt),
          status: "pending",
        });
      }),
    ),
  );
};
