import { and, eq, lt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { schema } from "../db/client.js";
import type { HubSpotClient } from "../hubspot/client.js";
import { processJob } from "./process-job.js";
import { sleep } from "../hubspot/backoff.js";
import os from "os";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 500);
const STALE_LOCK_TIMEOUT_MS = Number(process.env.WORKER_STALE_LOCK_TIMEOUT_MS ?? 300_000);

// Unique identity for this worker process — visible in jobs.locked_by
const WORKER_ID = `${os.hostname()}:${process.pid}`;

// ---------------------------------------------------------------------------
// Claim the next pending job using SKIP LOCKED.
// Returns null if the queue is empty.
// ---------------------------------------------------------------------------
async function claimNextJob(db: Db) {
  return db.transaction(async (tx) => {
    // FOR UPDATE SKIP LOCKED: multiple workers can poll simultaneously without
    // blocking each other. Each grabs a different row.
    const [job] = await tx
      .select()
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.status, "pending"),
          lt(schema.jobs.nextRunAt, sql`now()`),
        ),
      )
      .orderBy(schema.jobs.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });

    if (!job) return null;

    // Mark as running inside the same transaction so the row is never
    // visible as "pending" to another worker after we commit.
    await tx
      .update(schema.jobs)
      .set({
        status: "running",
        lockedAt: new Date(),
        lockedBy: WORKER_ID,
        attempts: job.attempts + 1,
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));

    return { ...job, attempts: job.attempts + 1 };
  });
}

// ---------------------------------------------------------------------------
// Reclaim jobs whose worker crashed mid-flight (locked_at is too old).
// Runs periodically — not on every poll tick.
// ---------------------------------------------------------------------------
async function reclaimStaleLocks(db: Db): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_LOCK_TIMEOUT_MS);
  await db
    .update(schema.jobs)
    .set({ status: "pending", lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(
      and(
        eq(schema.jobs.status, "running"),
        lt(schema.jobs.lockedAt, cutoff),
      ),
    );
}

// ---------------------------------------------------------------------------
// Single poll tick — returns true if a job was processed.
// Exported for integration tests.
// ---------------------------------------------------------------------------
export async function pollOnce(db: Db, hubspot: HubSpotClient): Promise<boolean> {
  const job = await claimNextJob(db);
  if (!job) return false;

  try {
    await processJob(job, db, hubspot);
  } catch (err) {
    // processJob handles retries internally and only re-throws unexpected errors.
    console.error(`[worker] unexpected error on job ${job.id}:`, err);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Main loop — runs until `running` is set to false (SIGTERM / SIGINT).
// ---------------------------------------------------------------------------
export async function startWorkerLoop(
  db: Db,
  hubspot: HubSpotClient,
): Promise<void> {
  let running = true;
  let sweepCounter = 0;

  const stop = () => {
    console.log("[worker] shutting down gracefully…");
    running = false;
  };

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  console.log(`[worker] started — id: ${WORKER_ID}, poll interval: ${POLL_INTERVAL_MS}ms`);

  while (running) {
    // Run the stale-lock sweep every ~60 ticks
    if (sweepCounter++ % 60 === 0) {
      await reclaimStaleLocks(db).catch((err) =>
        console.error("[worker] stale-lock sweep failed:", err),
      );
    }

    const processed = await pollOnce(db, hubspot);

    // If the queue was empty, back off before the next poll to avoid
    // hammering Postgres when there's nothing to do.
    if (!processed) {
      await sleep(POLL_INTERVAL_MS);
    }
    // If we processed a job, immediately try the next one — burst through
    // backlogs without waiting.
  }

  console.log("[worker] stopped");
}
