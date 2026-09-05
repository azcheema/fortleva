import { describe, expect, it } from "vitest";

import {
  EMAIL_LEVELS,
  NOTIFICATION_KINDS,
  emailAllowed,
  isEmailLevel,
  type NotificationKind,
} from "./catalog";

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

  it("every emailing kind names the weakest level that still gets it", () => {
    for (const [kind, spec] of Object.entries(NOTIFICATION_KINDS)) {
      if (!spec.email) continue;
      expect(EMAIL_LEVELS, kind).toContain(spec.email.atLevel);
      // NONE means no mail ever; a kind that could sit at NONE would
      // make the member's setting a suggestion rather than a rule.
      expect(spec.email.atLevel, kind).not.toBe("NONE");
    }
  });

  it("NONE is silent for every kind, ALL is loud for every emailing kind", () => {
    for (const kind of Object.keys(NOTIFICATION_KINDS) as NotificationKind[]) {
      expect(emailAllowed("NONE", kind), kind).toBe(false);
      expect(emailAllowed("ALL", kind), kind).toBe(Boolean(NOTIFICATION_KINDS[kind].email));
    }
  });

  it("the levels are a ladder: a kind allowed at a quiet level is allowed at every louder one", () => {
    for (const kind of Object.keys(NOTIFICATION_KINDS) as NotificationKind[]) {
      const allowed = EMAIL_LEVELS.map((l) => emailAllowed(l, kind));
      // Once true, never false again as the level gets louder.
      const firstTrue = allowed.indexOf(true);
      if (firstTrue === -1) continue;
      expect(allowed.slice(firstTrue).every(Boolean), kind).toBe(true);
    }
  });

  it("MENTIONS mails a mention and nothing else 2W sends", () => {
    expect(emailAllowed("MENTIONS", "comment.mentioned")).toBe(true);
    expect(emailAllowed("MENTIONS", "work_item.assigned")).toBe(false);
    expect(emailAllowed("PARTICIPATING", "work_item.assigned")).toBe(true);
  });

  it("isEmailLevel refuses anything the enum does not hold", () => {
    for (const l of EMAIL_LEVELS) expect(isEmailLevel(l)).toBe(true);
    for (const bad of ["", "all", "SOME", null, undefined]) expect(isEmailLevel(bad)).toBe(false);
  });

  it("2W ships instant email for assignment and mention only (plan §3.5)", () => {
    const instant = Object.entries(NOTIFICATION_KINDS)
      .filter(([, s]) => s.class === "INSTANT")
      .map(([k]) => k)
      .sort();
    expect(instant).toEqual(["comment.mentioned", "work_item.assigned"]);
  });
});
