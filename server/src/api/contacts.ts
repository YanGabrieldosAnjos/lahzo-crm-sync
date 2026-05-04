import { Router } from "express";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db } from "../db/client.js";
import { schema } from "../db/client.js";
import type {
  ContactListItem,
  ContactListResponse,
  ContactDetail,
  TimelineItem,
  SyncStatus,
  CrmSource,
  EventType,
  HttpMethod,
} from "@lahzo/shared";

export const contactsRouter = Router();

// ---------------------------------------------------------------------------
// Cursor helpers — keyset pagination on (last_event_at DESC, id DESC)
// ---------------------------------------------------------------------------
interface Cursor { d: string; i: string }

function encodeCursor(lastEventAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ d: lastEventAt.toISOString(), i: id })).toString("base64url");
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
    if (typeof parsed.d === "string" && typeof parsed.i === "string") return parsed as Cursor;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Row → wire type mappers (Date → ISO string, cast text → union)
// ---------------------------------------------------------------------------
function mapContact(row: typeof schema.contacts.$inferSelect): ContactListItem {
  return {
    id: row.id,
    crmSource: row.crmSource as CrmSource,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    score: row.score,
    status: row.status as SyncStatus,
    lastEventAt: row.lastEventAt.toISOString(),
    lastError: row.lastError,
  };
}

function mapSyncEvent(row: typeof schema.syncEvents.$inferSelect): TimelineItem {
  return {
    kind: "event",
    at: row.occurredAt.toISOString(),
    event: {
      id: row.id,
      crmSource: row.crmSource as CrmSource,
      eventId: row.eventId,
      crmObjectId: row.crmObjectId,
      eventType: row.eventType as EventType,
      occurredAt: row.occurredAt.toISOString(),
      receivedAt: row.receivedAt.toISOString(),
      payload: row.payload,
    },
  };
}

function mapApiCall(row: typeof schema.apiCalls.$inferSelect): TimelineItem {
  return {
    kind: "api_call",
    at: row.createdAt.toISOString(),
    call: {
      id: row.id,
      contactId: row.contactId,
      direction: "outbound",
      method: row.method as HttpMethod,
      url: row.url,
      requestBody: row.requestBody,
      responseStatus: row.responseStatus,
      responseBody: row.responseBody,
      attempt: row.attempt,
      latencyMs: row.latencyMs,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// GET /api/contacts
// ---------------------------------------------------------------------------
const listQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

contactsRouter.get("/", async (req, res) => {
  const query = listQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Invalid query params", details: query.error.flatten() });
    return;
  }

  const { status, limit, cursor } = query.data;
  const cursorData = cursor ? decodeCursor(cursor) : null;

  const filters = [];
  if (status) filters.push(eq(schema.contacts.status, status));
  if (cursorData) {
    const cursorDate = new Date(cursorData.d);
    // Keyset pagination: rows before the cursor position
    filters.push(
      or(
        lt(schema.contacts.lastEventAt, cursorDate),
        and(eq(schema.contacts.lastEventAt, cursorDate), lt(schema.contacts.id, cursorData.i)),
      ),
    );
  }

  // Fetch one extra to know if there's a next page
  const rows = await db
    .select()
    .from(schema.contacts)
    .where(filters.length ? and(...(filters as [ReturnType<typeof eq>])) : undefined)
    .orderBy(desc(schema.contacts.lastEventAt), desc(schema.contacts.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(mapContact);
  const lastRow = items[items.length - 1];
  const nextCursor =
    hasMore && lastRow
      ? encodeCursor(new Date(lastRow.lastEventAt), lastRow.id)
      : null;

  const response: ContactListResponse = { items, nextCursor };
  res.json(response);
});

// ---------------------------------------------------------------------------
// GET /api/contacts/:id
// ---------------------------------------------------------------------------
contactsRouter.get("/:id", async (req, res) => {
  const contact = await db.query.contacts.findFirst({
    where: eq(schema.contacts.id, req.params.id),
  });

  if (!contact) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  // Fetch inbound events and outbound calls in parallel
  const [eventRows, callRows] = await Promise.all([
    db
      .select()
      .from(schema.syncEvents)
      .where(
        and(
          eq(schema.syncEvents.crmSource, contact.crmSource),
          eq(schema.syncEvents.crmObjectId, contact.crmId),
        ),
      )
      .orderBy(desc(schema.syncEvents.occurredAt))
      .limit(50),

    db
      .select()
      .from(schema.apiCalls)
      .where(eq(schema.apiCalls.contactId, contact.id))
      .orderBy(desc(schema.apiCalls.createdAt))
      .limit(50),
  ]);

  // Merge and sort by timestamp descending — newest first
  const timeline: TimelineItem[] = [
    ...eventRows.map(mapSyncEvent),
    ...callRows.map(mapApiCall),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const response: ContactDetail = {
    contact: {
      ...mapContact(contact),
      crmId: contact.crmId,
      createdAt: contact.createdAt.toISOString(),
      updatedAt: contact.updatedAt.toISOString(),
    },
    timeline,
  };

  res.json(response);
});

// ---------------------------------------------------------------------------
// POST /api/contacts/:id/resync
// ---------------------------------------------------------------------------
contactsRouter.post("/:id/resync", async (req, res) => {
  const contact = await db.query.contacts.findFirst({
    where: eq(schema.contacts.id, req.params.id),
  });

  if (!contact) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    // Synthetic event so it appears in the timeline
    const [event] = await tx
      .insert(schema.syncEvents)
      .values({
        crmSource: contact.crmSource,
        eventId: `manual_${randomUUID()}`,
        crmObjectId: contact.crmId,
        eventType: "manual.resync",
        occurredAt: now,
        payload: { source: "operator", contactId: contact.id },
      })
      .returning({ id: schema.syncEvents.id });

    await tx.insert(schema.jobs).values({
      contactId: contact.id,
      syncEventId: event!.id,
      eventOccurredAt: now,
      status: "pending",
    });

    await tx
      .update(schema.contacts)
      .set({ status: "received", updatedAt: now })
      .where(eq(schema.contacts.id, contact.id));
  });

  res.status(202).json({ message: "Resync queued" });
});
