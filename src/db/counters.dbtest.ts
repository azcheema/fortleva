import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { nextCounter, withPlatform, withTenant } from "./index";
import { getPlatformClient, runtimeClient } from "./client";

const run = randomUUID().slice(0, 8);
const A = { id: randomUUID(), slug: `ctr-a-${run}` };
const B = { id: randomUUID(), slug: `ctr-b-${run}` };

beforeAll(async () => {
  await withPlatform(
    { type: "system", job: "counters-dbtest-seed" },
    "seed counters fixtures",
    async (tx) => {
      for (const t of [A, B]) {
        await tx.tenant.create({ data: { id: t.id, name: t.slug, slug: t.slug, entitlements: {} } });
      }
    },
    { readOnly: false },
  );
});

afterAll(async () => {
  const platform = getPlatformClient();
  await platform.$transaction(async (tx) => {
    const ids = [A.id, B.id];
    await tx.tenantCounter.deleteMany({ where: { tenantId: { in: ids } } });
    await tx.tenant.deleteMany({ where: { id: { in: ids } } });
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
    await tx.auditEvent.deleteMany({ where: { tenantId: { in: ids } } });
  });
  await platform.$disconnect();
  await runtimeClient.$disconnect();
});

describe("nextCounter", () => {
  it("25 parallel transactions yield exactly 1..25, no gaps or duplicates", async () => {
    const values = await Promise.all(
      Array.from({ length: 25 }, () =>
        withTenant(A.id, { type: "system" }, (tx) => nextCounter(tx, "ticket"), {
          timeoutMs: 20_000,
        }),
      ),
    );
    expect([...values].sort((x, y) => x - y)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
  });

  it("two tenants with the same key are independent", async () => {
    const b1 = await withTenant(B.id, { type: "system" }, (tx) => nextCounter(tx, "ticket"));
    const b2 = await withTenant(B.id, { type: "system" }, (tx) => nextCounter(tx, "ticket"));
    const a26 = await withTenant(A.id, { type: "system" }, (tx) => nextCounter(tx, "ticket"));
    expect([b1, b2]).toEqual([1, 2]);
    expect(a26).toBe(26);
  });

  it("refuses to run outside withTenant()", async () => {
    await expect(
      nextCounter(runtimeClient as never, "ticket"),
    ).rejects.toThrow(/inside withTenant/);
  });
});
