import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  sessionCookieAttributes,
  sessionCookieName,
  type Plane,
} from "./index";

const PLANES: Plane[] = ["member", "portal", "platform"];

describe("INV-D1: no cookie ever carries a Domain attribute (ARC-11)", () => {
  it("session cookie attributes contain no domain key", () => {
    for (const plane of PLANES) {
      const attrs = sessionCookieAttributes(plane);
      expect(Object.keys(attrs)).not.toContain("domain");
      expect(attrs.secure).toBe(true);
      expect(attrs.httpOnly).toBe(true);
      expect(attrs.path).toBe("/");
    }
  });

  it("session cookies are __Host- prefixed (browser rejects Domain on them)", () => {
    for (const plane of PLANES) {
      expect(sessionCookieName(plane)).toMatch(/^__Host-flv\./);
    }
  });

  it("no source file sets a cookie domain attribute", () => {
    const violations: string[] = [];
    for (const file of walk(join(process.cwd(), "src"))) {
      if (!/\.(ts|tsx)$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (!/cookie/i.test(code)) continue;
      if (/\bdomain\b\s*:/.test(code) || /Domain=/.test(code)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
