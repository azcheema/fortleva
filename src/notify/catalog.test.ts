import { describe, expect, it } from "vitest";

import { NOTIFICATION_KINDS } from "./catalog";

describe("notification kind catalog (§6.18; PLAN §2 tripwire)", () => {
  it("every CONTACT-audience kind is clientVisibleOnly", () => {
    for (const [kind, spec] of Object.entries(NOTIFICATION_KINDS)) {
      if (spec.audience === "CONTACT") {
        expect(spec.clientVisibleOnly, kind).toBe(true);
      }
    }
  });

  it("kind codes are entity.verb", () => {
    for (const kind of Object.keys(NOTIFICATION_KINDS)) {
      expect(kind).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it("only INSTANT kinds carry email behaviour", () => {
    for (const [kind, spec] of Object.entries(NOTIFICATION_KINDS)) {
      if (spec.class !== "INSTANT") expect(spec.email, kind).toBeUndefined();
    }
  });

  it("2W ships instant email for assignment and mention only (plan §3.5)", () => {
    const instant = Object.entries(NOTIFICATION_KINDS)
      .filter(([, s]) => s.class === "INSTANT")
      .map(([k]) => k)
      .sort();
    expect(instant).toEqual(["comment.mentioned", "work_item.assigned"]);
  });
});
