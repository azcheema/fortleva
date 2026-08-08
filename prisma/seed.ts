// Seeds the global Permission catalog (AUTHZ.md §3.2). Runs as the
// OWNER role (DIRECT_URL) — app_runtime deliberately has SELECT only
// on the catalog. Idempotent: codes are immutable upsert keys;
// description/module/requiresMfa follow the catalog.
import { config as loadEnv } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";

import { PERMISSIONS } from "../src/authz/catalog";
import { PrismaClient } from "../src/generated/prisma/client";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

async function main() {
  const url = process.env["DIRECT_URL"];
  if (!url) throw new Error("DIRECT_URL missing");

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });

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
  console.log(`Permission catalog seeded: ${count} codes`);

  const stray = await prisma.permission.findMany({
    where: { code: { notIn: PERMISSIONS.map((p) => p.code) } },
    select: { code: true },
  });
  if (stray.length > 0) {
    console.warn(
      `WARNING: ${stray.length} code(s) in DB not in the catalog (codes are never deleted, only flagged):`,
      stray.map((s) => s.code),
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
