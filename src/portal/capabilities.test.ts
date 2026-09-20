import { describe, expect, it } from "vitest";

import { MODULES } from "@/authz/catalog";

import {
  PORTAL_CAPABILITIES,
  PORTAL_CAPABILITY_DEFS,
  PORTAL_MODULES,
  PORTAL_PROFILES,
  isPortalCapability,
  isPortalProfile,
  profileHolds,
} from "./capabilities";

/**
 * The capability universe is FROZEN IN CODE (AUTHZ.md §8), so the tests
 * that matter are the pins: the exact union, the exact profile bundles,
 * and the exact module each capability rides on. A capability added
 * without a decision fails here, which is the whole point — on this
 * plane an addition is a grant.
 */

describe("the portal capability union", () => {
  it("is exactly the v1 allowlist", () => {
    expect([...PORTAL_CAPABILITIES].sort()).toEqual([
      "portal.comment.create",
      "portal.continuity.download",
      "portal.continuity.request_open",
      "portal.continuity.view_status",
      "portal.contract.sign",
      "portal.contract.view",
      "portal.credential.submit",
      "portal.deliverable.approve",
      "portal.document.download",
      "portal.document.view",
      "portal.hours.view",
      "portal.invoice.pay",
      "portal.invoice.view",
      "portal.project.view",
      "portal.request.create",
      "portal.share_link.view",
      "portal.timeline.view",
      "portal.update.view",
      "portal.version.approve",
      "portal.work_item.act",
      "portal.work_item.view",
    ]);
  });

  it("carries no retired or v2 name", () => {
    // portal.issue.* were retired 2026-08-16 in favour of
    // portal.work_item.* / portal.request.create / portal.comment.create;
    // portal.report.view is v2 and must not be grantable before it is
    // built, because CONTACT_PRIMARY holds everything in this union.
    for (const gone of [
      "portal.issue.view",
      "portal.issue.create",
      "portal.issue.comment",
      "portal.report.view",
    ]) {
      expect(isPortalCapability(gone), gone).toBe(false);
    }
  });

  it("uses the `portal.area.verb` namespace and nothing else", () => {
    // Three namespaces, never mixed (AGENTS.md): a stray `resource:verb`
    // or `entity.verb` here would be a permission code or an audit
    // action wearing a capability's clothes.
    for (const c of PORTAL_CAPABILITIES) {
      expect(c, c).toMatch(/^portal\.[a-z_]+\.[a-z_]+$/);
    }
  });

  it("names only real entitlement modules, and always includes `portal`", () => {
    for (const m of PORTAL_MODULES) {
      expect(MODULES, `${m} must be a catalog module`).toContain(m);
    }
    for (const c of PORTAL_CAPABILITIES) {
      const def = PORTAL_CAPABILITY_DEFS[c];
      expect(def.modules[0], `${c}: portal must be the first gate`).toBe("portal");
      for (const m of def.modules) expect(PORTAL_MODULES, `${c}: ${m}`).toContain(m);
      // At most one parent module beside `portal` — the 1:1 module↔folder
      // rule (AUTHZ.md §5) means a capability with two parents is a
      // capability in the wrong place.
      expect(def.modules.length, `${c}: at most one parent module`).toBeLessThanOrEqual(2);
    }
  });

  it("pins each capability's parent module", () => {
    const parents = Object.fromEntries(
      PORTAL_CAPABILITIES.map((c) => [c, PORTAL_CAPABILITY_DEFS[c].modules[1] ?? null]),
    );
    expect(parents).toEqual({
      "portal.project.view": null,
      "portal.version.approve": null,
      "portal.document.view": null,
      "portal.document.download": null,
      "portal.deliverable.approve": null,
      "portal.work_item.view": "work",
      "portal.work_item.act": "work",
      "portal.request.create": "work",
      "portal.comment.create": "work",
      "portal.update.view": "work",
      "portal.timeline.view": "work",
      "portal.hours.view": "time",
      "portal.credential.submit": "vault",
      "portal.share_link.view": "vault",
      "portal.invoice.view": "invoicing",
      "portal.invoice.pay": "invoicing",
      "portal.contract.view": "contracts",
      "portal.contract.sign": "contracts",
      "portal.continuity.view_status": "continuity_box",
      "portal.continuity.request_open": "continuity_box",
      "portal.continuity.download": "continuity_box",
    });
  });

  it("marks exactly the continuity capabilities sealed-box exempt", () => {
    const exempt = PORTAL_CAPABILITIES.filter(
      (c) => "sealedBoxExempt" in PORTAL_CAPABILITY_DEFS[c],
    ).sort();
    expect(exempt).toEqual([
      "portal.continuity.download",
      "portal.continuity.request_open",
      "portal.continuity.view_status",
    ]);
  });
});

describe("the two v1 contact profiles", () => {
  it("are exactly CONTACT_PRIMARY and CONTACT_COLLABORATOR", () => {
    // CONTACT_FINANCE is v2 and must not exist yet — an unknown profile
    // holds nothing, so shipping the name early would be harmless, but
    // shipping it with a bundle would not.
    expect(Object.keys(PORTAL_PROFILES).sort()).toEqual([
      "CONTACT_COLLABORATOR",
      "CONTACT_PRIMARY",
    ]);
    expect(isPortalProfile("CONTACT_FINANCE")).toBe(false);
  });

  it("CONTACT_PRIMARY holds every v1 capability — pinned, not merely derived", () => {
    // The bundle is derived from the union so it cannot drift from it;
    // this pin is the control that makes the derivation safe, because
    // adding a row to the union is otherwise a silent grant to every
    // primary contact in the product.
    expect([...PORTAL_PROFILES.CONTACT_PRIMARY].sort()).toEqual([...PORTAL_CAPABILITIES].sort());
    expect(PORTAL_PROFILES.CONTACT_PRIMARY.length).toBe(21);
  });

  it("CONTACT_COLLABORATOR holds exactly the collaborator bundle", () => {
    expect([...PORTAL_PROFILES.CONTACT_COLLABORATOR].sort()).toEqual([
      "portal.comment.create",
      "portal.credential.submit",
      "portal.document.download",
      "portal.document.view",
      "portal.project.view",
      "portal.request.create",
      "portal.share_link.view",
      "portal.timeline.view",
      "portal.update.view",
      "portal.work_item.act",
      "portal.work_item.view",
    ]);
  });

  it("CONTACT_COLLABORATOR holds no money, signature, continuity, hours or sign-off", () => {
    for (const withheld of [
      "portal.invoice.view",
      "portal.invoice.pay",
      "portal.contract.view",
      "portal.contract.sign",
      "portal.continuity.view_status",
      "portal.continuity.request_open",
      "portal.continuity.download",
      "portal.hours.view",
      "portal.deliverable.approve",
      "portal.version.approve",
    ]) {
      expect(profileHolds("CONTACT_COLLABORATOR", withheld), withheld).toBe(false);
      expect(profileHolds("CONTACT_PRIMARY", withheld), withheld).toBe(true);
    }
  });
});

describe("profileHolds fails closed", () => {
  it("denies an unknown profile everything", () => {
    for (const bogus of ["CONTACT_FINANCE", "OWNER", "", "contact_primary", null, undefined, 7]) {
      expect(profileHolds(bogus, "portal.project.view"), String(bogus)).toBe(false);
    }
  });

  it("denies an unknown capability to everybody", () => {
    for (const bogus of ["portal.everything", "client:view", "", null, undefined, {}]) {
      expect(profileHolds("CONTACT_PRIMARY", bogus), String(bogus)).toBe(false);
    }
  });

  it("is not fooled by a prototype key", () => {
    // `Object.hasOwn`, not `in`: "constructor" and "toString" are on
    // every object's prototype chain.
    expect(isPortalProfile("constructor")).toBe(false);
    expect(isPortalCapability("toString")).toBe(false);
  });
});
