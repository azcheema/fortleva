import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isPortalResetRequest, RESET_REQUEST_FLOOR_MS, withResponseFloor } from "./response-floor";

/** A clock the test drives: `sleep` advances time instead of waiting. */
const fakeClock = () => {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    advance: (ms: number) => {
      t += ms;
    },
    clock: {
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
    },
  };
};

const post = (path: string) =>
  new Request(`http://localhost:3000${path}`, { method: "POST", body: "{}" });

describe("the reset request's response floor", () => {
  it("holds a fast answer until the floor", async () => {
    const c = fakeClock();
    const handler = async () => {
      c.advance(12);
      return new Response("ok");
    };
    const wrapped = withResponseFloor(handler, () => true, RESET_REQUEST_FLOOR_MS, c.clock);
    await wrapped(post("/api/portal-auth/request-password-reset"));
    expect(c.slept).toEqual([RESET_REQUEST_FLOOR_MS - 12]);
  });

  it("makes a found and a not-found answer take the same time — the property it exists for", async () => {
    const elapsed = async (work: number) => {
      const c = fakeClock();
      const wrapped = withResponseFloor(
        async () => {
          c.advance(work);
          return new Response("same body");
        },
        () => true,
        RESET_REQUEST_FLOOR_MS,
        c.clock,
      );
      await wrapped(post("/api/portal-auth/request-password-reset"));
      return c.clock.now();
    };
    expect(await elapsed(3)).toBe(await elapsed(40));
  });

  it("adds nothing to an answer that is already slower than the floor", async () => {
    const c = fakeClock();
    const wrapped = withResponseFloor(
      async () => {
        c.advance(RESET_REQUEST_FLOOR_MS + 5);
        return new Response("slow");
      },
      () => true,
      RESET_REQUEST_FLOOR_MS,
      c.clock,
    );
    await wrapped(post("/api/portal-auth/request-password-reset"));
    expect(c.slept).toEqual([]);
  });

  it("holds a THROWN answer too, and still throws it", async () => {
    const c = fakeClock();
    const wrapped = withResponseFloor(
      async () => {
        c.advance(1);
        throw new Error("boom");
      },
      () => true,
      RESET_REQUEST_FLOOR_MS,
      c.clock,
    );
    await expect(wrapped(post("/api/portal-auth/request-password-reset"))).rejects.toThrow("boom");
    expect(c.slept).toEqual([RESET_REQUEST_FLOOR_MS - 1]);
  });

  it("leaves every other request alone", async () => {
    const c = fakeClock();
    const wrapped = withResponseFloor(async () => new Response("ok"), () => false, 1000, c.clock);
    await wrapped(post("/api/portal-auth/sign-in/email"));
    expect(c.slept).toEqual([]);
  });
});

describe("which requests are the reset request", () => {
  it("matches the endpoint and the spellings a router might also accept", () => {
    expect(isPortalResetRequest(post("/api/portal-auth/request-password-reset"))).toBe(true);
    expect(isPortalResetRequest(post("/api/portal-auth/request-password-reset/"))).toBe(true);
    expect(isPortalResetRequest(post("/api/portal-auth/Request-Password-Reset"))).toBe(true);
    expect(isPortalResetRequest(post("/api/portal-auth/request%2Dpassword-reset"))).toBe(true);
  });

  it("gives an undecodable path the floor rather than a pass", () => {
    expect(isPortalResetRequest(post("/api/portal-auth/%E0%A4%A"))).toBe(true);
  });

  it("does not slow sign-in, sign-out, the reset itself, or a GET", () => {
    expect(isPortalResetRequest(post("/api/portal-auth/sign-in/email"))).toBe(false);
    expect(isPortalResetRequest(post("/api/portal-auth/sign-out"))).toBe(false);
    expect(isPortalResetRequest(post("/api/portal-auth/reset-password"))).toBe(false);
    expect(
      isPortalResetRequest(new Request("http://localhost:3000/api/portal-auth/request-password-reset")),
    ).toBe(false);
  });
});

describe("the portal auth route", () => {
  /**
   * THE UNIT TESTS ABOVE SAY NOTHING IF THE ROUTE DOES NOT USE THE WRAPPER,
   * and the fix review said so: unwiring it in `route.ts` failed no test at
   * all. A source check rather than an import, because the route module
   * builds the portal Better Auth instance, which reaches the database —
   * the same reason `audit-hook-guard.test.ts` scans source.
   */
  it("holds its POST to the floor, and exports no second POST", () => {
    const route = readFileSync(
      join(process.cwd(), "src", "app", "api", "portal-auth", "[...all]", "route.ts"),
      "utf8",
    );
    expect(route).toMatch(
      /export const POST = withResponseFloor\(\s*handlers\.POST,\s*isPortalResetRequest,\s*RESET_REQUEST_FLOOR_MS,?\s*\)/,
    );
    expect(route.match(/export\s+(?:const|let|var|async\s+function|function)\s+POST\b/g)).toHaveLength(1);
    expect(route).not.toMatch(/export\s+const\s*\{[^}]*\bPOST\b/);
  });
});
