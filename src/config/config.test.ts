import { afterEach, describe, expect, it, vi } from "vitest";

import {
  absoluteUrl,
  appUrl,
  mailFrom,
  sessionCookieAttributes,
} from "./index";

describe("INV-D2: single config module owns host, cookies, sender", () => {
  it("builds absolute URLs from APP_URL only", () => {
    expect(absoluteUrl("/portal/invite/abc")).toBe(
      new URL("/portal/invite/abc", appUrl).toString(),
    );
  });

  it("composes the mail From header from configured parts", () => {
    expect(mailFrom.header).toBe(`${mailFrom.name} <${mailFrom.address}>`);
  });

  it("platform plane uses SameSite=strict; others lax", () => {
    expect(sessionCookieAttributes("platform").sameSite).toBe("strict");
    expect(sessionCookieAttributes("member").sameSite).toBe("lax");
    expect(sessionCookieAttributes("portal").sameSite).toBe("lax");
  });
});

/**
 * `src/config` parses `process.env` at module load, so each case needs a
 * second, differently-configured copy: resetModules + a dynamic import,
 * the same shape `proxy.test.ts` uses.
 */
async function configWith(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("./index");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * THE MAIL ESCAPE HATCH IS A PRODUCTION BYPASS, so it is pinned like one.
 *
 * `next start` runs as production, where `src/mailer` refuses the dev
 * transport — which made every mail-SENDING flow untestable from a
 * browser, not merely the mail. `MAIL_DEV_OUTBOX=1` lifts that for the
 * Playwright harness, and a review objected that a lone env flag is
 * exactly the shape `next.config.ts` argues at length is FORGEABLE: both
 * `next start` and `playwright.config.ts` load `.env.local` first, and
 * every hosting platform has an env panel. So it takes a second
 * condition that is structural rather than typed — the app must be
 * serving itself on loopback, which a real deployment never is.
 */
describe("MAIL_DEV_OUTBOX needs the flag AND a loopback origin", () => {
  it("is off by default", async () => {
    const c = await configWith({ APP_URL: "https://os.example.test" });
    expect(c.allowDevMailOutbox).toBe(false);
  });

  it("is off with the flag alone on a real origin — the forgeable case", async () => {
    const c = await configWith({ APP_URL: "https://os.example.test", MAIL_DEV_OUTBOX: "1" });
    expect(c.allowDevMailOutbox).toBe(false);
  });

  it("is off on loopback without the flag", async () => {
    const c = await configWith({ APP_URL: "http://127.0.0.1:3457" });
    expect(c.allowDevMailOutbox).toBe(false);
  });

  it("is on only for both together — which is the harness", async () => {
    for (const origin of ["http://127.0.0.1:3457", "http://localhost:3000"]) {
      const c = await configWith({ APP_URL: origin, MAIL_DEV_OUTBOX: "1" });
      expect(c.allowDevMailOutbox, origin).toBe(true);
    }
  });

  it("DOES NOT CRASH THE APPLICATION on a value somebody would plausibly type", async () => {
    // It was `z.enum(["0","1"])`, so `MAIL_DEV_OUTBOX=true` made
    // `envSchema.parse` throw at module load — the whole app refusing to
    // boot with a message about an enum. Anything but "1" is simply off.
    for (const value of ["true", "false", "0", "", "yes"]) {
      const c = await configWith({ APP_URL: "http://127.0.0.1:3457", MAIL_DEV_OUTBOX: value });
      expect(c.allowDevMailOutbox, value).toBe(value === "1");
    }
  });
});

describe("TRUSTED_PROXY_HOPS is what makes a client address trustworthy", () => {
  it("defaults to one proxy — the deployment RUNBOOK documents", async () => {
    const c = await configWith({ APP_URL: "https://os.example.test" });
    expect(c.trustedProxyHops).toBe(1);
  });

  it("takes a declared count, and rejects a nonsensical one", async () => {
    const c = await configWith({ APP_URL: "https://os.example.test", TRUSTED_PROXY_HOPS: "2" });
    expect(c.trustedProxyHops).toBe(2);
    await expect(
      configWith({ APP_URL: "https://os.example.test", TRUSTED_PROXY_HOPS: "-1" }),
    ).rejects.toThrow();
  });
});
