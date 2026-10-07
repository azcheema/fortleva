import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The vault retention's CROSS-TENANT shell (Phase 3V slice 99), with both
 * seams mocked — no database: what discovery asks for (binned logins a day
 * short of their 30, share links' records a day short of their 12 months,
 * and tombstones nobody sent, which wait for their links), that each tenant
 * is opened once, and that one tenant's failure neither stops the rest nor
 * logs the error's message (a Prisma message prints the query's
 * arguments). The per-tenant body is `retention.dbtest.ts`'.
 */

type Where = Record<string, unknown>;
const calls: { table: string; where: Where }[] = [];
const found: Record<string, { tenantId: string }[]> = {};

vi.mock("@/db", () => ({
  withPlatform: async (_actor: unknown, _reason: string, fn: (tx: unknown) => Promise<unknown>) => {
    const table = (name: string) => ({
      findMany: async ({ where }: { where: Where }) => {
        calls.push({ table: name, where });
        const key = name === "credentialItem" ? (where["purgedAt"] === null ? "binned" : "kept") : name;
        return found[key] ?? [];
      },
    });
    return fn({ credentialItem: table("credentialItem"), credentialShareLink: table("credentialShareLink") });
  },
}));

const purge = vi.fn();
vi.mock("@/modules/vault", () => ({
  BIN_DAYS: 30,
  SHARE_LINK_KEPT_MONTHS: 12,
  purgeVaultRetention: (...args: unknown[]) => purge(...args),
}));

const { runVaultRetention } = await import("./vault-retention");

const NOW = new Date("2031-06-15T10:00:00Z");
const DAY = 86_400_000;

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(found)) delete found[k];
  purge.mockReset();
  purge.mockResolvedValue({ deleted: 1, kept: 2, released: 3, links: 4 });
});
afterEach(() => vi.restoreAllMocks());

describe("discovery", () => {
  it("asks for binned logins a day short of 30, links' records a day short of 12 months, and tombstones nobody sent", async () => {
    await runVaultRetention(NOW);
    expect(calls).toEqual([
      { table: "credentialItem", where: { deletedAt: { lte: new Date(NOW.getTime() - 29 * DAY) }, purgedAt: null } },
      { table: "credentialShareLink", where: { expiresAt: { lt: new Date("2030-06-16T10:00:00Z") } } },
      { table: "credentialItem", where: { purgedAt: { not: null }, submittedByContactId: null } },
    ]);
  });

  it("opens each tenant once, whichever sources found it, and adds up what each did", async () => {
    found["binned"] = [{ tenantId: "t1" }, { tenantId: "t2" }];
    found["credentialShareLink"] = [{ tenantId: "t2" }];
    found["kept"] = [{ tenantId: "t3" }, { tenantId: "t1" }];
    const out = await runVaultRetention(NOW);
    expect(purge.mock.calls.map((c) => c[0]).sort()).toEqual(["t1", "t2", "t3"]);
    expect(out).toEqual({ tenants: 3, deleted: 3, kept: 6, released: 9, links: 12, failed: 0 });
  });
});

describe("one tenant's failure", () => {
  it("is counted and logged by name and code only, and the next tenant still runs", async () => {
    found["binned"] = [{ tenantId: "t1" }, { tenantId: "t2" }];
    const leak = "SELECT * FROM credential_item WHERE name = 'secret-name'";
    purge.mockImplementationOnce(async () => {
      throw Object.assign(new Error(leak), { name: "PrismaClientKnownRequestError", code: "P2010" });
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await runVaultRetention(NOW);
    expect(out.failed).toBe(1);
    expect(purge).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain("PrismaClientKnownRequestError (P2010)");
    expect(line).not.toContain("secret-name");
  });
});
