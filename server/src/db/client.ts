import "../env.js";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

export const pool = new pg.Pool({
  connectionString: databaseUrl,
  // Keep modest in dev. The webhook handler and worker share this pool.
  max: 10,
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;
export { schema };
