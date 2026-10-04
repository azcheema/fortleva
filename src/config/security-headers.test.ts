import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SECURITY_HEADERS, SHARE_PAGE_HEADERS } from "./security-headers";

describe("headers on every response", () => {
  it("no page of the app may be framed — by anyone, the same site included", () => {
    const byKey = new Map(SECURITY_HEADERS.map((h) => [h.key.toLowerCase(), h.value]));
    expect(byKey.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(byKey.get("x-frame-options")).toBe("DENY");
  });

  it("next.config.ts sends them on every path", () => {
    const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
    expect(config).toMatch(/import \{ SECURITY_HEADERS, SHARE_PAGE_HEADERS \} from "\.\/src\/config\/security-headers";/);
    expect(config).toMatch(/source: "\/:path\*", headers: \[\.\.\.SECURITY_HEADERS\]/);
  });

  it("a share link's page sends no Referer and is never indexed (slice 90)", () => {
    const byKey = new Map(SHARE_PAGE_HEADERS.map((h) => [h.key.toLowerCase(), h.value]));
    expect(byKey.get("referrer-policy")).toBe("no-referrer");
    expect(byKey.get("x-robots-tag")).toBe("noindex, nofollow");
    const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
    expect(config).toMatch(/source: "\/portal\/share\/:path\*", headers: \[\.\.\.SHARE_PAGE_HEADERS\]/);
  });
});
