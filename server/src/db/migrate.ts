import "../env.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";

async function main() {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("[db] migrations applied");
  await pool.end();
}

main().catch((err) => {
  console.error("[db] migration failed:", err);
  process.exit(1);
});
