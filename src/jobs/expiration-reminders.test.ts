import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The renewal reminders' CROSS-TENANT shell (Phase 3V slice 89), with both
 * seams mocked — no database: what discovery asks for (a window wide enough
 * for every zone, and tenants holding a passed dedupe row so their sweep
 * runs), and that one tenant's failure neither stops the rest nor logs the
 * error's message (a Prisma message prints the query's arguments). The
 * per-tenant body is `reminders.dbtest.ts`'.
 */

type Where = Record<string, unknown>;
const calls: { table: string; where: Where }[] = [];
const found: Record<string, { tenantId: string }[]> = {};

vi.mock("@/db", () => ({
  withPlatform: async (_actor: unknown, _reason: string, fn: (tx: unknown) => Promise<unknown>) => {
    const table = (name: string) => ({
      findMany: async ({ where }: { where: Where }) => {
        calls.push({ table: name, where });
        return found[name] ?? [];
      },
    });
    return fn({
      clientAsset: table("clientAsset"),
      service: table("service"),
      credentialItem: table("credentialItem"),
      expirationReminderSent: table("expirationReminderSent"),
    });
  },
}));

const sent = vi.fn();
vi.mock("@/modules/vault", () => ({ sendExpirationReminders: (...args: unknown[]) => sent(...args) }));

const { runExpirationReminders } = await import("./expiration-reminders");

const NOW = new Date("2031-06-15T10:00:00Z");
const DAY = 86_400_000;

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(found)) delete found[k];
  sent.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("discovery", () => {
  it("asks each source for a window two days either side of every zone's today and the 60-day horizon", async () => {
    await runExpirationReminders(NOW);
    const byTable = Object.fromEntries(calls.map((c) => [c.table, c.where]));
    const window = { gte: new Date(NOW.getTime() - 2 * DAY), lt: new Date(NOW.getTime() + 62 * DAY) };
    expect(byTable["clientAsset"]).toEqual({ status: "ACTIVE", expiresAt: window });
    expect(byTable["service"]).toEqual({ status: { not: "ENDED" }, endsAt: window }); // C55: the END only
    expect(byTable["credentialItem"]).toEqual({ deletedAt: null, expiresAt: window });
    // A tenant whose last date left the window still gets its sweep.
    expect(byTable["expirationReminderSent"]).toEqual({ dueOn: { lt: new Date(NOW.getTime() - 3 * DAY) } });
  });

  it("opens each tenant once, whichever sources found it", async () => {
    found["clientAsset"] = [{ tenantId: "t1" }];
    found["service"] = [{ tenantId: "t1" }, { tenantId: "t2" }];
    found["expirationReminderSent"] = [{ tenantId: "t3" }];
    sent.mockResolvedValue({ assets: 1, agreements: 0, logins: 0 });
    const out = await runExpirationReminders(NOW);
    expect(sent.mock.calls.map((c) => c[0])).toEqual(["t1", "t2", "t3"]);
    expect(sent.mock.calls.every((c) => c[1] === NOW)).toBe(true);
    expect(out).toEqual({ tenants: 3, assets: 3, agreements: 0, logins: 0, failed: 0 });
  });
});

describe("one tenant's failure", () => {
  it("is counted and logged by tenant and code — never by message — and the next tenant still runs", async () => {
    found["clientAsset"] = [{ tenantId: "t1" }, { tenantId: "t2" }];
    const boom = Object.assign(new Error("Invalid `prisma.emailOutbox.createMany()` invocation: toEmail someone@example.test"), {
      code: "P2034",
    });
    sent.mockRejectedValueOnce(boom).mockResolvedValueOnce({ assets: 0, agreements: 1, logins: 2 });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await runExpirationReminders(NOW);
    expect(out).toEqual({ tenants: 2, assets: 0, agreements: 1, logins: 2, failed: 1 });
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(line).toContain("t1");
    expect(line).toContain("P2034");
    expect(line).not.toContain("someone@example.test");
    expect(line).not.toContain("prisma.emailOutbox");
  });
});
