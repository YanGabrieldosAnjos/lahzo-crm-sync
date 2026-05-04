/**
 * Idempotency test: delivering the same HubSpot webhook event twice must
 * result in exactly one sync_events row and one jobs row, with the second
 * delivery being a silent no-op.
 *
 * Requires a running Postgres (docker compose up -d postgres).
 * Uses the real DB — supertest fires against an in-process Express app.
 */
import crypto from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { eq, and, inArray } from "drizzle-orm";

// Load env before importing anything that reads process.env
import "../src/env.js";

import { db, pool } from "../src/db/client.js";
import { schema } from "../src/db/client.js";
import { hubspotWebhookHandler } from "../src/webhooks/hubspot.js";

// ---------------------------------------------------------------------------
// Test app — mirrors the real index.ts setup for the webhook route
// ---------------------------------------------------------------------------
const app = express();
app.use("/webhooks/hubspot", express.raw({ type: "application/json" }));
app.post("/webhooks/hubspot", hubspotWebhookHandler);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SECRET = "test-secret-idempotency";
const BASE_URL = "http://localhost:3000";

function makePayload(eventId: number, objectId: number) {
  return JSON.stringify([
    {
      eventId,
      subscriptionId: 1,
      portalId: 1,
      appId: 1,
      occurredAt: 1714732800000, // fixed — signature is stable for the whole test
      subscriptionType: "contact.creation",
      attemptNumber: 0,
      objectId,
      changeSource: "CRM",
    },
  ]);
}

function signedHeaders(body: string): Record<string, string> {
  const timestamp = String(Date.now());
  const signature = crypto
    .createHmac("sha256", SECRET)
    .update("POST" + `${BASE_URL}/webhooks/hubspot` + body + timestamp)
    .digest("base64");
  return {
    "x-hubspot-signature-v3": signature,
    "x-hubspot-request-timestamp": timestamp,
  };
}

function postWebhook(body: string) {
  const headers = signedHeaders(body);
  // Use .type() AFTER .send() to prevent supertest overriding the content-type
  // when it detects a Buffer. Sending as string ensures byte-perfect preservation.
  return request(app)
    .post("/webhooks/hubspot")
    .set(headers)
    .set("content-type", "application/json")
    .send(body);
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------
beforeAll(() => {
  process.env.HUBSPOT_WEBHOOK_SECRET = SECRET;
  process.env.PUBLIC_BASE_URL = BASE_URL;
});

afterAll(async () => {
  // Clean up test rows so repeated runs stay idempotent
  const testEventIds = ["888888", "999999"];
  const events = await db
    .select({ id: schema.syncEvents.id })
    .from(schema.syncEvents)
    .where(inArray(schema.syncEvents.eventId, testEventIds));

  if (events.length) {
    await db.delete(schema.jobs).where(
      inArray(schema.jobs.syncEventId, events.map((e) => e.id)),
    );
    await db.delete(schema.syncEvents).where(
      inArray(schema.syncEvents.id, events.map((e) => e.id)),
    );
  }

  // Clean up test contacts
  await db.delete(schema.contacts).where(
    and(
      eq(schema.contacts.crmSource, "hubspot"),
      inArray(schema.contacts.crmId, ["100001", "100002"]),
    ),
  );

  await pool.end();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Webhook idempotency", () => {
  it("delivers the same event twice → exactly one sync_events row and one job", async () => {
    const EVENT_ID = 888888;
    const OBJECT_ID = 100001;
    const body = makePayload(EVENT_ID, OBJECT_ID);

    const r1 = await postWebhook(body);
    expect(r1.status).toBe(200);

    const r2 = await postWebhook(body); // identical payload
    expect(r2.status).toBe(200);

    // Handler returns 200 before DB writes complete — wait briefly
    await new Promise((r) => setTimeout(r, 300));

    const eventRows = await db
      .select()
      .from(schema.syncEvents)
      .where(eq(schema.syncEvents.eventId, String(EVENT_ID)));

    expect(eventRows).toHaveLength(1);

    const jobRows = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.syncEventId, eventRows[0]!.id));

    expect(jobRows).toHaveLength(1);
  });

  it("invalid signature → 400, nothing written to DB", async () => {
    const body = makePayload(999999, 100002);
    const res = await request(app)
      .post("/webhooks/hubspot")
      .set("content-type", "application/json")
      .set("x-hubspot-signature-v3", "definitely-wrong")
      .set("x-hubspot-request-timestamp", String(Date.now()))
      .send(body);

    expect(res.status).toBe(400);

    // Nothing should be written for a rejected request
    const rows = await db
      .select()
      .from(schema.syncEvents)
      .where(eq(schema.syncEvents.eventId, "999999"));

    expect(rows).toHaveLength(0);
  });
});
