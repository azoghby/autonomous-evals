import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["./packages/core/src/db/schema.ts", "./packages/core/src/db/oauth-schema.ts"],
  out: "./packages/core/src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL! },
});
