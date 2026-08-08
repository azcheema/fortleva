import { describe, expect, it } from "vitest";

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
