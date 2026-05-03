/**
 * Idempotently creates the two custom Contact properties our integration writes back:
 *   - lahzo_score      (number)
 *   - lahzo_status     (enumeration, mirrors SyncStatus)
 *
 * Run with: npm run hubspot:bootstrap
 */
import "../src/env.js";
import type { SyncStatus } from "@lahzo/shared";

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) {
  console.error("HUBSPOT_TOKEN missing in .env — see docs/hubspot-setup.md");
  process.exit(1);
}

const API = "https://api.hubapi.com/crm/v3/properties/contacts";

const STATUS_OPTIONS: { label: string; value: SyncStatus; displayOrder: number }[] = [
  { label: "Received",     value: "received",      displayOrder: 0 },
  { label: "Processing",   value: "processing",    displayOrder: 1 },
  { label: "Synced",       value: "synced",        displayOrder: 2 },
  { label: "Failed",       value: "failed",        displayOrder: 3 },
  { label: "Skipped (stale)", value: "skipped_stale", displayOrder: 4 },
];

const PROPERTIES = [
  {
    name: "lahzo_score",
    label: "Lahzo Score",
    type: "number",
    fieldType: "number",
    groupName: "contactinformation",
    description: "Computed lead score from Lahzo CRM Sync.",
  },
  {
    name: "lahzo_status",
    label: "Lahzo Status",
    type: "enumeration",
    fieldType: "select",
    groupName: "contactinformation",
    description: "Sync lifecycle status from Lahzo CRM Sync.",
    options: STATUS_OPTIONS,
  },
] as const;

async function ensureProperty(prop: (typeof PROPERTIES)[number]): Promise<void> {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(prop),
  });

  if (res.ok) {
    console.log(`[hubspot] created property ${prop.name}`);
    return;
  }

  // HubSpot returns 409 with category PROPERTY_DOESNT_EXIST_OR_ALREADY_EXISTS
  // when the name is taken. Treat that as success — script is idempotent.
  if (res.status === 409) {
    console.log(`[hubspot] property ${prop.name} already exists — skipping`);
    return;
  }

  const body = await res.text();
  throw new Error(
    `[hubspot] failed to create property ${prop.name}: ${res.status} ${body}`,
  );
}

async function main(): Promise<void> {
  for (const prop of PROPERTIES) {
    await ensureProperty(prop);
  }
  console.log("[hubspot] bootstrap complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
