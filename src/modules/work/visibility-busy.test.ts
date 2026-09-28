import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A SPENT RETRY IS TOLD, NEVER A 500 (Phase 3 slice 72).
 *
 * The sharing UI's cascade can cycle with an attachment's visibility flip,
 * the portal switch's fan-out and a contact revoke (rank-lock.ts), and it
 * waits on the project's queue with a bound. Every one of those shapes
 * must reach the member as a sentence — `VISIBILITY_BUSY`, or
 * `CONTACT_ACCESS_BUSY` for the revoke — with nothing written, the way
 * `setPortalEnabled`'s first cut did not (retry.ts: a caller that
 * translates only ONE of the two shapes leaves the other to arrive raw).
 * The dbtest proves the lock-timeout half against a real held lock; a
 * deadlock cannot be forced three times running there (after the first
 * abort the colleague still holds its locks, so the retry blocks and ends
 * as a timeout instead), so the translation is pinned here, with the
 * database seam replaced by one that fails every attempt the way Prisma
 * reports each shape: BOTH shapes for the visibility module's `contended`
 * (the cascade, the bulk share, and `makeItemPrivate`'s fallback — the
 * three wait with a bound); the DEADLOCK shape alone for the attachment
 * flip and the contact revoke, which ask for no lock bound and use
 * `retryOnDeadlock`, so they cannot raise 55P03. If either ever gains a
 * `lockTimeoutMs`, it must translate `isLockTimeout` too, and a
 * lock-timeout case belongs here.
 */

const deadlock = { code: "P2039", message: "Database error. Code: `40P01`. Message: `deadlock detected`" };
const lockTimeout = {
  code: "P2039",
  message: "Database error. Code: `55P03`. Message: `canceling statement due to lock timeout`",
};

const failWith = vi.hoisted(() => ({ error: null as unknown }));
const withTenant = vi.hoisted(() =>
  vi.fn(async () => {
    throw failWith.error;
  }),
);
vi.mock("@/db", () => ({ withTenant, nextCounter: vi.fn() }));
// The revoke's module reaches the auth instance and the mailer at import;
// neither is touched before its transaction, which is what fails here.
vi.mock("@/auth", () => ({ portalInviteUrl: vi.fn() }));
vi.mock("@/mailer", () => ({ send: vi.fn() }));

import { setContactPortalAccess } from "@/clients/contact-access";
import { changeVisibility } from "@/documents/service";
import { DomainError } from "@/lib/domain-error";

import { bulkShare, makeItemPrivate, makePrivateWithChildren } from "./visibility";

const ctx = { tenantId: "tenant", actor: { memberId: "member" } } as never;

beforeEach(() => {
  withTenant.mockClear();
});

describe("the cascade and the bulk share translate BOTH contention shapes", () => {
  for (const [shape, error] of [
    ["a deadlock", deadlock],
    ["a lock timeout", lockTimeout],
  ] as const) {
    it(`makePrivateWithChildren: ${shape} on every attempt is VISIBILITY_BUSY, after three attempts`, async () => {
      failWith.error = error;
      const r = makePrivateWithChildren(ctx, ["item"]);
      await expect(r).rejects.toBeInstanceOf(DomainError);
      await expect(r).rejects.toMatchObject({ code: "VISIBILITY_BUSY" });
      expect(withTenant).toHaveBeenCalledTimes(3);
    });

    it(`bulkShare: ${shape} on every attempt is VISIBILITY_BUSY, after three attempts`, async () => {
      failWith.error = error;
      await expect(bulkShare(ctx, ["item"])).rejects.toMatchObject({ code: "VISIBILITY_BUSY" });
      expect(withTenant).toHaveBeenCalledTimes(3);
    });
  }

  it("makeItemPrivate: the plain flip's HAS_VISIBLE_CHILDREN, then a spent cascade, is VISIBILITY_BUSY — the door never 500s", async () => {
    let calls = 0;
    withTenant.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new DomainError("HAS_VISIBLE_CHILDREN");
      throw deadlock;
    });
    try {
      await expect(makeItemPrivate(ctx, "item")).rejects.toMatchObject({ code: "VISIBILITY_BUSY" });
      // One plain flip, then three cascade attempts.
      expect(withTenant).toHaveBeenCalledTimes(4);
    } finally {
      withTenant.mockImplementation(async () => {
        throw failWith.error;
      });
    }
  });

  it("anything else passes through untranslated and is not retried", async () => {
    const other = new Error("boom");
    failWith.error = other;
    await expect(makePrivateWithChildren(ctx, ["item"])).rejects.toBe(other);
    expect(withTenant).toHaveBeenCalledTimes(1);
  });
});

describe("the attachment flip, a new partner of the cascade's cycle, is retried and told", () => {
  it("a deadlock on every attempt is VISIBILITY_BUSY, after three attempts", async () => {
    failWith.error = deadlock;
    await expect(changeVisibility(ctx, "doc", "INTERNAL")).rejects.toMatchObject({ code: "VISIBILITY_BUSY" });
    expect(withTenant).toHaveBeenCalledTimes(3);
  });
});

describe("the contact revoke, a new partner of the cascade's cycle, is retried and told", () => {
  it("a deadlock on every attempt is CONTACT_ACCESS_BUSY, after three attempts — never a 500 on the cut-off control", async () => {
    failWith.error = deadlock;
    await expect(setContactPortalAccess(ctx, "contact", "REMOVE")).rejects.toMatchObject({
      code: "CONTACT_ACCESS_BUSY",
    });
    expect(withTenant).toHaveBeenCalledTimes(3);
  });
});
