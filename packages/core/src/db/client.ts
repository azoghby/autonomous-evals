import { neon, Pool } from "@neondatabase/serverless";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import * as schema from "./schema";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

let httpDb: ReturnType<typeof drizzleHttp<typeof schema>> | undefined;

/** HTTP driver: one round-trip per query, ideal for route handlers and workflow steps. */
export function db() {
  httpDb ??= drizzleHttp(neon(databaseUrl()), { schema });
  return httpDb;
}

export { schema };
export type { Pool };
