import { describe, expect, it } from "vitest";

import { PERMISSIONS, ROLE_TEMPLATES, permissionsForTemplate } from "@/authz/catalog";

import { missingFrom } from "./subset";
import { cloneCodesForTemplate } from "./templates";

describe("clone code sets (AUTHZ.md §3.5: ✦ never auto-propagates to clones)", () => {
  it("every template clone = template minus requiresMfa codes", () => {
    for (const t of ROLE_TEMPLATES) {
      const clone = new Set(cloneCodesForTemplate(t.templateKey));
      const full = permissionsForTemplate(t.templateKey);
      for (const p of full) expect(clone.has(p.code)).toBe(!p.requiresMfa);
      expect(clone.size).toBe(full.filter((p) => !p.requiresMfa).length);
    }
  });

  it("an owner clone lacks exactly the ✦ set (deprecated codes seed nowhere)", () => {
    const clone = new Set(cloneCodesForTemplate("owner"));
    const mfa = PERMISSIONS.filter((p) => p.requiresMfa).map((p) => p.code);
    expect(mfa.length).toBeGreaterThan(0);
    for (const code of mfa) expect(clone.has(code)).toBe(false);
    const live = PERMISSIONS.filter((p) => !p.deprecated);
    expect(clone.size + mfa.length).toBe(live.length);
  });
});

describe("missingFrom (grant-subset arithmetic)", () => {
  it("returns the wanted codes the actor lacks, in order, empty when subset", () => {
    const held = new Set(["a:x", "b:y"]);
    expect(missingFrom(held, ["a:x"])).toEqual([]);
    expect(missingFrom(held, ["b:y", "c:z", "a:x", "d:w"])).toEqual(["c:z", "d:w"]);
    expect(missingFrom(new Set(), [])).toEqual([]);
  });
});
