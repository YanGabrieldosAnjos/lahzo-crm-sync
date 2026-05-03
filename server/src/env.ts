import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// .env lives at the monorepo root, two levels above this file.
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../.env") });
