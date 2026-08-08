import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withPlatform, withUser } from "./index";
import { getPlatformClient, runtimeClient } from "./client";

const run = randomUUID().slice(0, 8);
const tenant = { id: randomUUID(), slug: `wu-${run}` };
const me = { id: randomUUID(), email: `wu-me-${run}@test.invalid` };
const other = { id: randomUUID(), email: `wu-other-${run}@test.invalid` };

beforeAll(async () => {
  await withPlatform(
    { type: "system", job: "with-user-test-seed" },
    "seed withUser fixtures",
    async (tx) => {
      await tx.tenant.create({
        data: { id: tenant.id, name: tenant.slug, slug: tenant.slug, entitlements: {} },
      });
      for (const u of [me, other]) {
        await tx.user.create({ data: { id: u.id, name: u.email, email: u.email } });
        await tx.member.create({
          data: { tenantId: tenant.id, userId: u.id },
        });
      }
    },
    { readOnly: false },
  );
});

afterAll(async () => {
  const platform = getPlatformClient();
  await platform.member.deleteMany({ where: { tenantId: tenant.id } });
  await platform.tenant.delete({ where: { id: tenant.id } });
  await platform.user.deleteMany({ where: { id: { in: [me.id, other.id] } } });
  await platform.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
  await platform.$disconnect();
  await runtimeClient.$disconnect();
});

describe("withUser self-visibility (member_self_select)", () => {
  it("a user sees exactly their own memberships and those tenants' rows", async () => {
    const rows = await withUser(me.id, (tx) =>
      tx.member.findMany({ include: { tenant: { select: { name: true } } } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(me.id);
    expect(rows[0]?.tenant.name).toBe(tenant.slug);
  });

  it("cannot widen the query to other users' memberships", async () => {
    const rows = await withUser(me.id, (tx) =>
      tx.member.findMany({ where: { userId: other.id } }),
    );
    expect(rows).toEqual([]);
  });

  it("no user GUC (plain runtime query) still sees zero rows", async () => {
    const n = await runtimeClient.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM member`;
    expect(n[0]?.n).toBe(0);
  });
});
