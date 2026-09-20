import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The plane boundary at the door (SECURITY.md §3.3, ARC-12).
 *
 * These cases exist because the platform console's auth API belonged to
 * NEITHER host until 2026-09-09: `/api/platform-auth/*` matched no
 * pass-through, so on the app host it fell through to the generic branch
 * whose only gate is the PRESENCE of a member cookie — a value any
 * scripted client can invent — while on a real ops host the platform
 * branch swept it under `/ops` and 404'd the console's own sign-in. The
 * two halves hid each other, so neither was visible in either
 * configuration.
 *
 * The rules pinned here are cheap to state and were expensive to miss:
 * the console and its API live on the ops host and NOWHERE else.
 */

const OPS = "ops.example.test";
const APP = "app.example.test";

/**
 * `src/config` parses `process.env` at module load, so the ops-host
 * cases need the env stubbed BEFORE the import. resetModules + dynamic
 * import is the only way to get a second, differently-configured copy.
 */
async function proxyWith(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const mod = await import("./proxy");
  return mod.proxy;
}

const req = (host: string, path: string, cookie?: string) =>
  new NextRequest(`https://${host}${path}`, {
    headers: new Headers({ host, ...(cookie ? { cookie } : {}) }),
  });

/** Where a NextResponse actually sends the request. */
const dest = (res: { status: number; headers: Headers }) => {
  const rewrite = res.headers.get("x-middleware-rewrite");
  const location = res.headers.get("location");
  if (rewrite) return `rewrite:${new URL(rewrite).pathname}`;
  if (location) return `redirect:${new URL(location, "https://x.test").pathname}`;
  return "next";
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("proxy: the platform auth API is host-scoped", () => {
  it("serves /api/platform-auth/* on the ops host", async () => {
    const proxy = await proxyWith({ APP_URL: `https://${APP}`, OPS_URL: `https://${OPS}` });
    // Must NOT be swept under /ops: that path has no route, so the
    // console's own sign-in would 404 on the host meant to serve it.
    expect(dest(proxy(req(OPS, "/api/platform-auth/sign-in/email")))).toBe("next");
    expect(dest(proxy(req(OPS, "/api/platform-auth/two-factor/verify-totp")))).toBe("next");
  });

  it("404s /api/platform-auth/* on the app host, cookie or not", async () => {
    const proxy = await proxyWith({ APP_URL: `https://${APP}`, OPS_URL: `https://${OPS}` });
    // The forged-cookie case is the whole point: the generic branch this
    // used to fall into gates on cookie PRESENCE, never on its value.
    expect(dest(proxy(req(APP, "/api/platform-auth/sign-in/email")))).toBe("rewrite:/404");
    expect(
      dest(proxy(req(APP, "/api/platform-auth/sign-in/email", "__Host-flv.member=anything"))),
    ).toBe("rewrite:/404");
    expect(dest(proxy(req(APP, "/api/platform-auth/two-factor/enable")))).toBe("rewrite:/404");
    expect(dest(proxy(req(APP, "/api/platform-auth/forget-password")))).toBe("rewrite:/404");
  });

  it("404s /api/platform-auth/* when no separate ops host is configured", async () => {
    // OPS_URL unset means opsUrl.host === appUrl.host, planeForHost never
    // answers "platform", and the console is absent by construction. Its
    // API must be absent with it rather than answering on the app host.
    const proxy = await proxyWith({ APP_URL: `https://${APP}` });
    expect(dest(proxy(req(APP, "/api/platform-auth/sign-in/email")))).toBe("rewrite:/404");
  });

  it("404s the MEMBER auth API on the ops host", async () => {
    const proxy = await proxyWith({ APP_URL: `https://${APP}`, OPS_URL: `https://${OPS}` });
    expect(dest(proxy(req(APP, "/api/auth/sign-in/email")))).toBe("next");
    // Cookie signatures do not bind the cookie NAME — better-call signs
    // the value alone, and both instances share one secret and one
    // `verification` table. So a `better-auth.two_factor` challenge
    // minted here would replay verbatim as `flv-ops.two_factor` at the
    // platform verify endpoint and stamp a PLATFORM session's
    // mfaVerifiedAt. Denying the member instance any way to mint a
    // challenge on this host is what closes that; `cookiePrefix` alone
    // does not.
    expect(dest(proxy(req(OPS, "/api/auth/sign-in/email")))).toBe("rewrite:/404");
    expect(dest(proxy(req(OPS, "/api/auth/two-factor/verify-totp")))).toBe("rewrite:/404");
    expect(dest(proxy(req(OPS, "/api/dev-storage/x")))).toBe("rewrite:/404");
  });
});

describe("proxy: the console lives on the ops host and nowhere else", () => {
  it("404s the console login on the app host", async () => {
    // It is in PUBLIC_PATHS for the ops host's benefit, and that used to
    // exempt it here too — giving the platform credential form a second
    // front door on the tenant origin, with no console behind it.
    const proxy = await proxyWith({ APP_URL: `https://${APP}`, OPS_URL: `https://${OPS}` });
    expect(dest(proxy(req(APP, "/ops/login")))).toBe("rewrite:/404");
    expect(dest(proxy(req(APP, "/ops")))).toBe("rewrite:/404");
  });

  it("serves the console login on the ops host without demanding a cookie", async () => {
    const proxy = await proxyWith({ APP_URL: `https://${APP}`, OPS_URL: `https://${OPS}` });
    // If this ever redirects, the login page redirects to itself and the
    // console is unreachable — the failure the PUBLIC_PATHS entry exists
    // to prevent.
    expect(dest(proxy(req(OPS, "/ops/login")))).toBe("next");
  });

  it("sends a cookieless console request to the console login", async () => {
    const proxy = await proxyWith({ APP_URL: `https://${APP}`, OPS_URL: `https://${OPS}` });
    expect(dest(proxy(req(OPS, "/ops")))).toBe("redirect:/ops/login");
  });

  it("keeps the ops host off the member app", async () => {
    const proxy = await proxyWith({ APP_URL: `https://${APP}`, OPS_URL: `https://${OPS}` });
    expect(dest(proxy(req(OPS, "/home")))).toBe("redirect:/ops/home");
  });
});

describe("proxy: the portal plane (Phase 3)", () => {
  const PORTAL_COOKIE = "__Host-flv.portal";
  const MEMBER_COOKIE = "__Host-flv.member";

  it("serves the portal auth API on the app host and 404s it on ops", async () => {
    // Same rule, same reason as the two APIs above: cookie signatures do
    // not bind the cookie NAME and one secret serves all three
    // instances, so a credential surface answering on the wrong host is
    // a way to mint that plane's cookies where the host's controls do
    // not reach.
    const proxy = await proxyWith({ APP_URL: `https://${APP}`, OPS_URL: `https://${OPS}` });
    expect(dest(proxy(req(APP, "/api/portal-auth/sign-in/email")))).toBe("next");
    expect(dest(proxy(req(OPS, "/api/portal-auth/sign-in/email")))).toBe("rewrite:/404");
    // With a cookie too — presence is not a pass on the wrong host.
    expect(dest(proxy(req(OPS, "/api/portal-auth/sign-in/email", `${PORTAL_COOKIE}=x`)))).toBe(
      "rewrite:/404",
    );
  });

  it("sends a cookieless portal request to the PORTAL login, not the member one", async () => {
    // Before the portal arm existed this landed on /login: a form that
    // cannot authenticate a contact, on a plane they have no account in,
    // asking a client for the agency's own staff credentials.
    const proxy = await proxyWith({ APP_URL: `https://${APP}` });
    expect(dest(proxy(req(APP, "/portal/projects")))).toBe("redirect:/portal/login");
  });

  it("serves the portal login without demanding a cookie", async () => {
    const proxy = await proxyWith({ APP_URL: `https://${APP}` });
    expect(dest(proxy(req(APP, "/portal/login")))).toBe("next");
  });

  it("does not accept a MEMBER cookie as entry to the portal", async () => {
    const proxy = await proxyWith({ APP_URL: `https://${APP}` });
    expect(dest(proxy(req(APP, "/portal/projects", `${MEMBER_COOKIE}=x`)))).toBe(
      "redirect:/portal/login",
    );
    // …nor the reverse. The door checks the NAME only; the authoritative
    // check is the session table behind it (src/auth/portal.ts).
    expect(dest(proxy(req(APP, "/home", `${PORTAL_COOKIE}=x`)))).toBe("redirect:/login");
  });

  it("keeps the portal off the ops host entirely", async () => {
    const proxy = await proxyWith({ APP_URL: `https://${APP}`, OPS_URL: `https://${OPS}` });
    // The ops host serves only the console, so /portal is swept under
    // /ops — where nothing answers.
    expect(dest(proxy(req(OPS, "/portal/projects")))).toBe("redirect:/ops/portal/projects");
  });
});
