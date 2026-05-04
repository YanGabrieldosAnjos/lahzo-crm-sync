import { eq, and } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { schema } from "../db/client.js";
import type { JobRow } from "../db/schema.js";
import { HubSpotClient } from "../hubspot/client.js";
import { Mapping } from "../hubspot/mapping.js";
import { backoffMs, sleep } from "../hubspot/backoff.js";
import type { SyncStatus } from "@lahzo/shared";

const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS ?? 5);

const mapping = new Mapping();

// ---------------------------------------------------------------------------
// Score computation — deterministic hash of contact fields → 0–100
// Same contact always produces the same score, making the output reviewable.
// ---------------------------------------------------------------------------
function computeScore(
  email: string | null,
  firstName: string | null,
  lastName: string | null,
): number {
  const input = `${email ?? ""}|${firstName ?? ""}|${lastName ?? ""}`;
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
    h = h >>> 0; // keep as 32-bit unsigned
  }
  return Number(((h / 0xffffffff) * 100).toFixed(1));
}

// ---------------------------------------------------------------------------
// Main processor — called by the loop for each dequeued job.
// Handles its own DB updates: stale-skip, processing, synced, failed.
// Throws only for unexpected errors not caught internally.
// ---------------------------------------------------------------------------
export async function processJob(
  job: JobRow,
  db: Db,
  hubspot: HubSpotClient,
): Promise<void> {
  // Read the contact to check stale-update guard
  const contact = await db.query.contacts.findFirst({
    where: eq(schema.contacts.id, job.contactId),
  });

  if (!contact) {
    // Contact deleted between enqueue and processing — mark job done, move on
    await db
      .update(schema.jobs)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(schema.jobs.id, job.id));
    return;
  }

  // ------------------------------------------------------------------
  // Stale-update protection
  // If this event happened before the last one we already processed,
  // skip it — we'd be overwriting newer data with older.
  // ------------------------------------------------------------------
  if (job.eventOccurredAt <= contact.lastEventAt) {
    await db.transaction(async (tx) => {
      await tx
        .update(schema.jobs)
        .set({ status: "done", updatedAt: new Date() })
        .where(eq(schema.jobs.id, job.id));
      await tx
        .update(schema.contacts)
        .set({ status: "skipped_stale" as SyncStatus, updatedAt: new Date() })
        .where(eq(schema.contacts.id, job.contactId));
    });
    return;
  }

  // Mark contact as processing so the UI reflects in-flight work
  await db
    .update(schema.contacts)
    .set({ status: "processing" as SyncStatus, updatedAt: new Date() })
    .where(eq(schema.contacts.id, job.contactId));

  try {
    // Fetch current full state from HubSpot — single source of truth
    const raw = await hubspot.getContact(contact.crmId, contact.id);
    const fields = mapping.mapFromHubSpot(raw);

    // Simulate enrichment + AI scoring (3–15 seconds)
    const enrichMs = 3_000 + Math.random() * 12_000;
    await sleep(enrichMs);

    const score = computeScore(fields.email, fields.firstName, fields.lastName);

    // Persist enriched contact locally
    await db
      .update(schema.contacts)
      .set({
        email: fields.email,
        firstName: fields.firstName,
        lastName: fields.lastName,
        score,
        status: "synced" as SyncStatus,
        lastEventAt: job.eventOccurredAt,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.contacts.id, job.contactId));

    // Write score + status back to HubSpot
    const writebackProps = mapping.mapToHubSpotProperties(score, "synced");
    await hubspot.updateContactProperties(
      contact.crmId,
      writebackProps as Record<string, string>,
      contact.id,
    );

    // Mark job complete
    await db
      .update(schema.jobs)
      .set({ status: "done", lockedAt: null, lockedBy: null, updatedAt: new Date() })
      .where(eq(schema.jobs.id, job.id));
  } catch (err) {
    await handleFailure(job, err as Error, db);
  }
}

// ---------------------------------------------------------------------------
// Retry / failure bookkeeping
// ---------------------------------------------------------------------------
async function handleFailure(job: JobRow, err: Error, db: Db): Promise<void> {
  const attempts = job.attempts + 1;
  const exhausted = attempts >= MAX_ATTEMPTS;

  await db.transaction(async (tx) => {
    await tx
      .update(schema.jobs)
      .set({
        status: exhausted ? "failed" : "pending",
        attempts,
        nextRunAt: exhausted ? job.nextRunAt : new Date(Date.now() + backoffMs(attempts)),
        lastError: err.message,
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));

    if (exhausted) {
      await tx
        .update(schema.contacts)
        .set({
          status: "failed" as SyncStatus,
          lastError: err.message,
          updatedAt: new Date(),
        })
        .where(eq(schema.contacts.id, job.contactId));
    }
  });
}
