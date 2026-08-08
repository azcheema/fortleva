import { defineConfig } from "prisma/config";
import { config as loadEnv } from "dotenv";

// Next.js loads .env.local itself at runtime; the Prisma CLI does not,
// so migrations and studio need it loaded here.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  // Migrate runs on the unpooled OWNER connection (DIRECT_URL); the app
  // runtime uses the restricted app_runtime role via DATABASE_URL in
  // src/db — never the other way around (TENANCY.md §6.1).
  datasource: {
    url: process.env["DIRECT_URL"] ?? "",
  },
});
