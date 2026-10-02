import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthzError } from "@/authz/errors";
import { DomainError } from "@/lib/domain-error";

const tenantContext = vi.fn();
vi.mock("@/members/tenant-context", () => ({ requireTenantContext: () => tenantContext() }));

const { fieldOf, vaultFailure, vaultFieldPost, vaultPost } = await import("./respond");

/**
 * The vault's HTTP edge (`respond.ts`): what it refuses BEFORE a session
 * is read, how a service refusal becomes a status, and that no answer is
 * ever cacheable or carries anything the caller sent.
 */

const ID = "0b9a3f1e-2c4d-4e5f-8a6b-7c8d9e0f1a2b";
const params = (id = ID) => Promise.resolve({ id });
const post = (body?: string, site: string | null = "same-origin") =>
  new Request(`https://os.example.test/api/vault/${ID}/reveal`, {
    method: "POST",
    headers: site === null ? {} : { "sec-fetch-site": site },
    ...(body === undefined ? {} : { body }),
  });

beforeEach(() => {
  tenantContext.mockReset();
  tenantContext.mockResolvedValue({ membership: { tenantId: "t1" }, actor: { memberId: "m1" } });
});

const expectNoStore = (r: Response) => {
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
};

describe("refused before a session is read", () => {
  it.each([["cross-site"], ["same-site"], ["none"], [null]])("Sec-Fetch-Site %s → 403 CROSS_SITE", async (site) => {
    const act = vi.fn();
    const r = await vaultFieldPost(post(JSON.stringify({ field: "password" }), site), params(), act);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "CROSS_SITE" });
    expectNoStore(r);
    expect(tenantContext).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });

  it("an id that is not a UUID is NOT_FOUND", async () => {
    const r = await vaultFieldPost(post(JSON.stringify({ field: "password" })), params("../../etc"), vi.fn());
    expect(r.status).toBe(404);
    expect(tenantContext).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "{field:"],
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"password"'],
    ["too long", JSON.stringify({ field: "password", pad: "x".repeat(600) })],
  ])("a body that is %s → 400, and nothing of it is echoed", async (_what, body) => {
    const r = await vaultFieldPost(post(body), params(), vi.fn());
    expect(r.status).toBe(400);
    expect(await r.text()).toBe(JSON.stringify({ error: "INVALID_INPUT" }));
    expect(tenantContext).not.toHaveBeenCalled();
  });

  it("a body that DECLARES more than the cap is refused before it is read", async () => {
    const request = new Request(`https://os.example.test/api/vault/${ID}/reveal`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "content-length": "1000000" },
      body: JSON.stringify({ field: "password" }),
    });
    const r = await vaultFieldPost(request, params(), vi.fn());
    expect(r.status).toBe(400);
    expect(request.bodyUsed).toBe(false);
    expect(tenantContext).not.toHaveBeenCalled();
  });

  it("a body that streams past the cap without declaring it is cut off there", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 100) controller.close();
        else controller.enqueue(new TextEncoder().encode("x".repeat(100)));
      },
    });
    const request = new Request(`https://os.example.test/api/vault/${ID}/reveal`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const r = await vaultFieldPost(request, params(), vi.fn());
    expect(r.status).toBe(400);
    expect(pulled).toBeLessThan(20);
  });

  it.each([[{}], [{ field: "" }], [{ field: 7 }], [{ field: "f".repeat(65) }]])(
    "a reveal or copy without a usable field %j → 400",
    async (body) => {
      const r = await vaultFieldPost(post(JSON.stringify(body)), params(), vi.fn());
      expect(r.status).toBe(400);
      expect(tenantContext).not.toHaveBeenCalled();
    },
  );

  it("fieldOf takes a short non-empty string only", () => {
    expect(fieldOf({ field: "password" })).toBe("password");
    expect(fieldOf({ field: "" })).toBeNull();
    expect(fieldOf({ field: ["password"] })).toBeNull();
    expect(fieldOf({})).toBeNull();
  });
});

describe("the service call", () => {
  it("passes the session's tenant and actor, the id and the field, and answers no-store JSON", async () => {
    const act = vi.fn().mockResolvedValue({ value: "s3cret" });
    const r = await vaultFieldPost(post(JSON.stringify({ field: "password" })), params(), act);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ value: "s3cret" });
    expectNoStore(r);
    expect(act).toHaveBeenCalledWith({ tenantId: "t1", actor: { memberId: "m1" } }, ID, "password");
  });

  it("a TOTP post needs no body", async () => {
    const act = vi.fn().mockResolvedValue({ code: "123456" });
    const r = await vaultPost(post(), params(), act);
    expect(r.status).toBe(200);
    expect(act).toHaveBeenCalledWith({ tenantId: "t1", actor: { memberId: "m1" } }, ID);
  });

  it.each([
    [new AuthzError("MFA_REQUIRED", "step_up"), 401, { error: "MFA_REQUIRED", remedy: "step_up" }],
    [new AuthzError("MFA_REQUIRED", "enrol"), 401, { error: "MFA_REQUIRED", remedy: "enrol" }],
    [new AuthzError("NOT_FOUND"), 404, { error: "NOT_FOUND" }],
    [new AuthzError("FORBIDDEN", "impersonation never reveals"), 403, { error: "FORBIDDEN" }],
    [new AuthzError("DISABLED_BY_TENANT"), 403, { error: "FORBIDDEN" }],
    [new DomainError("REVEAL_BUDGET_EXCEEDED"), 429, { error: "REVEAL_BUDGET_EXCEEDED" }],
    [new DomainError("VAULT_BUSY"), 503, { error: "VAULT_BUSY" }],
    [new DomainError("INVALID_INPUT", "field is not set"), 400, { error: "INVALID_INPUT" }],
  ])("%s → %i, the code only", async (err, status, body) => {
    const r = await vaultFieldPost(post(JSON.stringify({ field: "password" })), params(), vi.fn().mockRejectedValue(err));
    expect(r.status).toBe(status);
    expect(await r.json()).toEqual(body);
    expectNoStore(r);
  });

  it("anything else is a real failure and propagates", async () => {
    const boom = new Error("connection reset");
    await expect(vaultFieldPost(post(JSON.stringify({ field: "password" })), params(), vi.fn().mockRejectedValue(boom))).rejects.toBe(boom);
    expect(() => vaultFailure(boom)).toThrow(boom);
  });
});
