import "./env.js";
import { db, pool } from "./db/client.js";
import { createHubSpotClient } from "./hubspot/client.js";
import { startWorkerLoop } from "./worker/loop.js";

async function main() {
  const hubspot = createHubSpotClient(db);
  await startWorkerLoop(db, hubspot);
  await pool.end();
}

main().catch((err) => {
  console.error("[worker] fatal error:", err);
  process.exit(1);
});
