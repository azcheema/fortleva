import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The inbox housekeeping's CROSS-TENANT shell (Phase 5 slice 104), with both
 * database doors mocked — no database: what discovery asks for, that each
 * tenant is opened once, that the platform door is used for DISCOVERY ONLY —
 * the archive and the delete both run as the tenant's own SYSTEM principal
 * (TENANCY.md §12; a first cut deleted through `withPlatform` and wrote a
 * "delete" audit row into every active tenant's log on every run — the code
 * and security reviews' medium) — and that one tenant's failure neither
 * stops the rest nor logs the error's message. The SQL itself, and the
 * database's own hold on the delete, are `src/notify/inbox-polish.dbtest.ts`'.
 */

type Call = { door: "platform" | "tenant"; tenantId?: string; sql: string; values: unknown[]; opts?: unknown };
const calls: Call[] = [];
const discovery: Record<"old" | "full" | "due", string[]> = { old: [], full: [], due: [] };
const failing = new Set<string>();

const sqlOf = (strings: TemplateStringsArray) => strings.join("?");

vi.mock("@/db", () => ({
  withPlatform: async (_actor: unknown, _reason: string, fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
    fn({
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = sqlOf(strings);
        calls.push({ door: "platform", sql, values, opts });
        const key = sql.includes("HAVING") ? "full" : sql.includes("archived_at IS NOT NULL") ? "due" : "old";
        return discovery[key].map((tenant_id) => ({ tenant_id }));
      },
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ door: "platform", sql: sqlOf(strings), values, opts });
        return 0;
      },
    }),
  withTenant: async (
    tenantId: string,
    principal: unknown,
    fn: (tx: unknown) => Promise<unknown>,
    opts?: unknown,
  ) => {
    if (failing.has(tenantId)) {
      throw Object.assign(new Error("UPDATE notification SET … WHERE receiver_id = 'secret-member'"), {
        name: "PrismaClientKnownRequestError",
        code: "P2010",
      });
    }
    return fn({
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ door: "tenant", tenantId, sql: sqlOf(strings), values, opts: { principal, ...(opts as object) } });
        return 2;
      },
    });
  },
}));

const { runNotificationRetention } = await import("./notification-retention");

const NOW = new Date("2031-06-15T10:00:00Z");
const DAY = 86_400_000;

beforeEach(() => {
  calls.length = 0;
  discovery.old = [];
  discovery.full = [];
  discovery.due = [];
  failing.clear();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("discovery", () => {
  it("asks a day early: unarchived rows past 89 days, and archived ones a day short of 12 months", async () => {
    await runNotificationRetention(NOW);
    const asked = calls.filter((c) => c.door === "platform");
    expect(asked.map((c) => c.values)).toEqual([
      [new Date(NOW.getTime() - 89 * DAY)],
      [500],
      [new Date("2030-06-16T10:00:00Z")],
    ]);
    // Read-only (no `readOnly: false`), with a budget for three table passes.
    for (const c of asked) expect(c.opts).toEqual({ timeoutMs: 60_000 });
  });

  it("opens each tenant once, whichever passes found it, and adds up what each did", async () => {
    discovery.old = ["t1", "t2"];
    discovery.full = ["t2"];
    discovery.due = ["t3", "t1"];
    const out = await runNotificationRetention(NOW);
    const archived = calls.filter((c) => c.door === "tenant" && c.sql.includes("UPDATE notification"));
    expect(archived.map((c) => c.tenantId).sort()).toEqual(["t1", "t2", "t3"]);
    expect(out).toEqual({ tenants: 3, archived: 6, deleted: 6, failed: 0 });
  });
});

describe("the doors", () => {
  it("archives and deletes as the tenant's own SYSTEM principal, lock-bounded — never a platform write", async () => {
    discovery.old = ["t1"];
    discovery.due = ["t1"];
    await runNotificationRetention(NOW);
    expect(calls.filter((c) => c.door === "platform" && !c.sql.includes("SELECT DISTINCT"))).toEqual([]);
    const writes = calls.filter((c) => c.door === "tenant");
    expect(writes.map((c) => (c.sql.includes("DELETE FROM notification") ? "delete" : "archive"))).toEqual([
      "archive",
      "delete",
    ]);
    for (const c of writes) {
      expect(c.tenantId).toBe("t1");
      expect(c.opts).toEqual({ principal: { type: "system" }, timeoutMs: 30_000, lockTimeoutMs: 5_000 });
    }
  });
});

describe("one tenant's failure", () => {
  it("is counted and logged by name and code only, and the next tenant still runs", async () => {
    discovery.old = ["t1", "t2"];
    failing.add("t1");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await runNotificationRetention(NOW);
    expect(out.failed).toBe(1);
    expect(out.archived).toBe(2);
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain("t1");
    expect(line).toContain("PrismaClientKnownRequestError (P2010)");
    expect(line).not.toContain("secret-member");
  });
});
