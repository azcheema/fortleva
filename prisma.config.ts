import { defineConfig } from "prisma/config";
import { config as loadEnv } from "dotenv";

// Next.js loads .env.local itself at runtime; the Prisma CLI does not,
// so migrations and studio need it loaded here. `quiet`: dotenv 17 prints
// a banner to STDOUT by default, and `prisma migrate diff --script >
// migration.sql` captured it into a migration as two lines of non-SQL
// (caught by the pre-apply review of 20261001120000, 2026-10-01).
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  // Migrate runs on the unpooled OWNER connection (DIRECT_URL); the app
  // runtime uses the restricted app_runtime role via DATABASE_URL in
  // src/db — never the other way around (TENANCY.md §6.1).
  datasource: {
    url: process.env["DIRECT_URL"] ?? "",
  },
});
