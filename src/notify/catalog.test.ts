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

  /**
   * THE INSTANT SET IS A CLOSED LIST BECAUSE INSTANT MEANS MAIL.
   * `plan §3.5` pinned it at two for 2W ("assignment + mention are the
   * ONLY instant email kinds; everything else coalesces until Phase 5
   * digests"), and that sentence is about 2W rather than about the
   * product for ever — so this assertion is the place each later
   * addition has to be argued, which is the whole reason it is written
   * as an equality and not as a subset.
   *
   * `work_item.request_received` is the third, added with the portal
   * request intake (Phase 3 slice 6a). It earns INSTANT on the one
   * ground that separates the two classes: a request is the only thing
   * a CLIENT can put on the agency's board, and an agency that learns
   * about it in Friday's digest has a client who was ignored all week.
   * A coalesced kind would have been the safer-looking choice and the
   * wrong one.
   *
   * `work_item.completed_by_contact` is the fourth (Phase 3 slice 6c)
   * and its argument is the mirror of the third's. A task assigned to a
   * CONTACT is work the agency has handed out and is BLOCKED on; the
   * tick is the moment it comes back. Learning about it in a digest
   * means having paid for the round trip and then sitting on the
   * answer. The two client-caused kinds are therefore both INSTANT, and
   * that is the line this list draws: a fact only the CLIENT can
   * produce reaches a person, everything the agency does to its own
   * board waits for the digest.
   */
  it("instant email is assignment, mention and the two client-caused kinds — and nothing else", () => {
    const instant = Object.entries(NOTIFICATION_KINDS)
      .filter(([, s]) => s.class === "INSTANT")
      .map(([k]) => k)
      .sort();
    expect(instant).toEqual([
      "comment.mentioned",
      "work_item.assigned",
      "work_item.completed_by_contact",
      "work_item.request_received",
    ]);
  });

  /**
   * MENTIONS is the quietest level that still mails, and it must stay
   * the level for a kind that NAMES you. A request names nobody, so a
   * member who has turned email down to "only when I am mentioned" must
   * not get one — the same rule assignment already follows.
   */
  it("a client request mails at PARTICIPATING, never at MENTIONS", () => {
    expect(emailAllowed("MENTIONS", "work_item.request_received")).toBe(false);
    expect(emailAllowed("PARTICIPATING", "work_item.request_received")).toBe(true);
  });

  /** The same rule, for the other kind a client can cause: a tick names nobody. */
  it("a client's completion tick mails at PARTICIPATING, never at MENTIONS", () => {
    expect(emailAllowed("MENTIONS", "work_item.completed_by_contact")).toBe(false);
    expect(emailAllowed("PARTICIPATING", "work_item.completed_by_contact")).toBe(true);
  });

  /**
   * The audience field names who RECEIVES, not who caused it. A request
   * is contact-CAUSED and member-ADDRESSED, which is the first kind in
   * the catalog where the two differ — so the `clientVisibleOnly`
   * tripwire (required on every CONTACT-audience kind) must not be set
   * on it, and its absence has to be a test rather than a comment.
   */
  it("a client request is a MEMBER kind and carries no client-visibility claim", () => {
    const spec = NOTIFICATION_KINDS["work_item.request_received"];
    expect(spec.audience).toBe("MEMBER");
    expect(spec.clientVisibleOnly).toBeUndefined();
  });

  /** And the second one, for the same reason — contact-CAUSED, member-ADDRESSED. */
  it("a client's completion tick is a MEMBER kind and carries no client-visibility claim", () => {
    const spec = NOTIFICATION_KINDS["work_item.completed_by_contact"];
    expect(spec.audience).toBe("MEMBER");
    expect(spec.clientVisibleOnly).toBeUndefined();
  });
});
