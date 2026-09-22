// THE CATALOG HALF OF `prisma/seed.ts`, AND DELIBERATELY ONLY THAT HALF.
//
//   pnpm exec tsx scripts/seed-catalog.ts
//
// `prisma/seed.ts` does two things. It upserts the global `Permission`
// catalog — platform-level, idempotent, additive, and codes are never
// deleted — and it then runs B3 template propagation, which writes
// `RolePermission` rows into EVERY EXISTING TENANT'S roles.
//
// THAT SECOND HALF IS NOT AN AGENT'S TO RUN. AGENTS.md is explicit:
// never create roles or write to the database outside a throwaway tenant
// your own test provisions, and never touch the `naxdor` tenant.
// Propagation does both, for every tenant at once.
//
// THE FIRST HALF, HOWEVER, IS OWED BY EVERY CODE BUMP AND IS SAFE:
// `src/members/templates.ts` grants a role its codes by looking them up
// BY CODE, so a tenant provisioned after a catalogue addition — every
// throwaway tenant a dbtest creates — silently misses the new code until
// the `Permission` row exists. Written on 2026-09-22, when
// `work_item:triage_decline` (TEMPLATE_VERSION 6) made that concrete:
// without this, `triage.dbtest.ts` could not exercise the founder's
// Accept/Decline split at all, because its own fresh tenant's owner
// would not hold the code the service requires.
//
// **A RELEASE STILL OWES THE FULL `prisma/seed.ts`.** This script is
// what makes the tests runnable; propagation is what gives an existing
// tenant's owners and managers the code in production, and that is the
// founder's to run.
import { config as loadEnv } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";

import { PERMISSIONS } from "../src/authz/catalog";
import { PrismaClient } from "../src/generated/prisma/client";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

async function main() {
  const url = process.env["DIRECT_URL"];
  if (!url) throw new Error("DIRECT_URL missing");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  const existing = new Set(
    (await prisma.permission.findMany({ select: { code: true } })).map((p) => p.code),
  );
  const added = PERMISSIONS.filter((p) => !existing.has(p.code)).map((p) => p.code);

  for (const perm of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: perm.code },
      create: {
        code: perm.code,
        description: perm.description,
        module: perm.module,
        requiresMfa: perm.requiresMfa,
      },
      update: {
        description: perm.description,
        module: perm.module,
        requiresMfa: perm.requiresMfa,
      },
    });
  }

  const count = await prisma.permission.count();
  console.log(`Permission catalog: ${count} codes (${added.length} new${added.length ? `: ${added.join(", ")}` : ""})`);
  // NO template propagation. See the header — that half writes to every
  // tenant's roles and belongs to the release, not to a test run.
  console.log("Template propagation NOT run — `prisma/seed.ts` owns that (see this file's header).");
  await prisma.$disconnect();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
