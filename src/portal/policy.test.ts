import { describe, expect, it } from "vitest";

import { parseEntitlements } from "@/entitlements/resolver";

import {
  PORTAL_CAPABILITIES,
  PORTAL_MODULES,
  type PortalCapability,
  type PortalModule,
} from "./capabilities";
import {
  computePortalModuleGates,
  portalModuleVerdict,
  portalPrincipalVerdict,
  type PortalModuleGates,
  type PortalModuleGateState,
} from "./policy";

/**
 * The whole deny matrix that does not need a database — and on this
 * plane that is most of it. Database-free by construction (policy.ts
 * imports nothing but types), so it runs in the unit suite, before
 * `migrate deploy`, with no DATABASE_URL.
 */

const allGates = (state: PortalModuleGateState): PortalModuleGates =>
  Object.fromEntries(PORTAL_MODULES.map((m) => [m, state])) as PortalModuleGates;

const gatesWith = (overrides: Partial<Record<PortalModule, PortalModuleGateState>>) =>
  ({ ...allGates("ok"), ...overrides }) as PortalModuleGates;

const ACTIVE = { portalStatus: "ACTIVE", invitedAt: new Date("2026-09-01T00:00:00Z") } as const;

describe("portalPrincipalVerdict — the contact half", () => {
  it("passes an ACTIVE, invited contact holding the capability", () => {
    expect(
      portalPrincipalVerdict({
        ...ACTIVE,
        profile: "CONTACT_COLLABORATOR",
        capability: "portal.project.view",
      }),
    ).toEqual({ ok: true });
  });

  it("denies every non-ACTIVE status, including ones it has never heard of", () => {
    for (const portalStatus of [
      "NO_ACCESS",
      "INVITED",
      "SUSPENDED",
      "REVOKED",
      "active",
      "",
      null,
      undefined,
      true,
    ]) {
      const v = portalPrincipalVerdict({
        portalStatus,
        invitedAt: ACTIVE.invitedAt,
        profile: "CONTACT_PRIMARY",
        capability: "portal.project.view",
      });
      expect(v, String(portalStatus)).toEqual({
        ok: false,
        reason: "FORBIDDEN",
        detail: "contact is not ACTIVE",
      });
    }
  });

  it("denies an ACTIVE contact that was never invited", () => {
    // The stronger reading of "invite-only is an invariant": the stamp
    // on the ROW, not merely the absence of a signup route in the code.
    for (const invitedAt of [null, undefined]) {
      expect(
        portalPrincipalVerdict({
          portalStatus: "ACTIVE",
          invitedAt,
          profile: "CONTACT_PRIMARY",
          capability: "portal.project.view",
        }),
      ).toEqual({ ok: false, reason: "FORBIDDEN", detail: "contact was never invited" });
    }
  });

  it("denies an unknown capability before it looks at anything else", () => {
    // A typo must read as "denied", never as "allowed" — and the reason
    // must not depend on the contact, because it is a config error.
    expect(
      portalPrincipalVerdict({
        ...ACTIVE,
        profile: "CONTACT_PRIMARY",
        capability: "portal.everything",
      }),
    ).toEqual({ ok: false, reason: "FORBIDDEN", detail: "unknown portal capability" });
    // …even when the contact is in no state to be allowed anything.
    expect(
      portalPrincipalVerdict({ portalStatus: "REVOKED", capability: "client:view" }),
    ).toEqual({ ok: false, reason: "FORBIDDEN", detail: "unknown portal capability" });
  });

  it("denies an unknown profile every capability in the union", () => {
    for (const capability of PORTAL_CAPABILITIES) {
      expect(
        portalPrincipalVerdict({ ...ACTIVE, profile: "CONTACT_FINANCE", capability }),
        capability,
      ).toEqual({ ok: false, reason: "FORBIDDEN", detail: "capability not in profile" });
    }
  });

  it("is the audience gate: the full profile × capability matrix", () => {
    const withheldFromCollaborator = new Set<PortalCapability>([
      "portal.version.approve",
      "portal.deliverable.approve",
      "portal.hours.view",
      "portal.invoice.view",
      "portal.invoice.pay",
      "portal.contract.view",
      "portal.contract.sign",
      "portal.continuity.view_status",
      "portal.continuity.request_open",
      "portal.continuity.download",
    ]);
    for (const capability of PORTAL_CAPABILITIES) {
      expect(
        portalPrincipalVerdict({ ...ACTIVE, profile: "CONTACT_PRIMARY", capability }).ok,
        `PRIMARY / ${capability}`,
      ).toBe(true);
      expect(
        portalPrincipalVerdict({ ...ACTIVE, profile: "CONTACT_COLLABORATOR", capability }).ok,
        `COLLABORATOR / ${capability}`,
      ).toBe(!withheldFromCollaborator.has(capability));
    }
  });
});

describe("portalModuleVerdict — gates 1–3", () => {
  it("passes every capability when every module is ok", () => {
    for (const capability of PORTAL_CAPABILITIES) {
      expect(portalModuleVerdict(capability, allGates("ok")).ok, capability).toBe(true);
    }
  });

  it("denies EVERY capability when the portal module itself is off", () => {
    // No `continuityBoxSealed` is passed anywhere here, so the §5
    // exemption does not apply to anything — including the continuity
    // capabilities. That IS the default, and it is the point: the
    // exemption's precondition is "once a box is SEALED".
    for (const state of ["FEATURE_DISABLED", "NOT_ENTITLED", "DISABLED_BY_TENANT"] as const) {
      for (const capability of PORTAL_CAPABILITIES) {
        expect(
          portalModuleVerdict(capability, gatesWith({ portal: state })),
          `${capability} / ${state}`,
        ).toEqual({ ok: false, reason: state, detail: "portal" });
      }
    }
  });

  it("names the parent module when only the parent is off", () => {
    expect(portalModuleVerdict("portal.hours.view", gatesWith({ time: "NOT_ENTITLED" }))).toEqual({
      ok: false,
      reason: "NOT_ENTITLED",
      detail: "time",
    });
    expect(
      portalModuleVerdict("portal.request.create", gatesWith({ work: "DISABLED_BY_TENANT" })),
    ).toEqual({ ok: false, reason: "DISABLED_BY_TENANT", detail: "work" });
    expect(
      portalModuleVerdict("portal.credential.submit", gatesWith({ vault: "FEATURE_DISABLED" })),
    ).toEqual({ ok: false, reason: "FEATURE_DISABLED", detail: "vault" });
    expect(
      portalModuleVerdict("portal.invoice.pay", gatesWith({ invoicing: "NOT_ENTITLED" })),
    ).toEqual({ ok: false, reason: "NOT_ENTITLED", detail: "invoicing" });
    expect(
      portalModuleVerdict("portal.contract.sign", gatesWith({ contracts: "NOT_ENTITLED" })),
    ).toEqual({ ok: false, reason: "NOT_ENTITLED", detail: "contracts" });
  });

  it("reports the OUTERMOST module that is off", () => {
    // `portal` is first in every capability's list, so a tenant with
    // both off hears about the portal rather than about the plan for a
    // module they cannot reach anyway.
    expect(
      portalModuleVerdict(
        "portal.hours.view",
        gatesWith({ portal: "FEATURE_DISABLED", time: "NOT_ENTITLED" }),
      ),
    ).toEqual({ ok: false, reason: "FEATURE_DISABLED", detail: "portal" });
  });

  it("leaves a capability whose parent is entitled alone when a SIBLING module is off", () => {
    expect(portalModuleVerdict("portal.project.view", gatesWith({ time: "NOT_ENTITLED" })).ok).toBe(
      true,
    );
    expect(portalModuleVerdict("portal.work_item.view", gatesWith({ vault: "NOT_ENTITLED" })).ok).toBe(
      true,
    );
  });

  const CONTINUITY = [
    "portal.continuity.view_status",
    "portal.continuity.request_open",
    "portal.continuity.download",
  ] as const;

  it("applies the §5 exemption ONLY when the box is proven sealed", () => {
    // "Once a box is SEALED" is a precondition, not scene-setting. The
    // first cut of capabilities.ts applied the exemption unconditionally,
    // so a tenant that had never bought `continuity_box` passed gate 2
    // anyway — the commercial gate on continuity was not enforced for
    // contacts at any time. Both fresh reviews caught it; nothing in the
    // matrix could distinguish sealed from never-sealed, because nothing
    // was asked.
    for (const capability of CONTINUITY) {
      expect(
        portalModuleVerdict(capability, gatesWith({ continuity_box: "NOT_ENTITLED" })),
        `${capability} / unsealed`,
      ).toEqual({ ok: false, reason: "NOT_ENTITLED", detail: "continuity_box" });
      expect(
        portalModuleVerdict(capability, gatesWith({ continuity_box: "NOT_ENTITLED" }), {
          continuityBoxSealed: false,
        }).ok,
        `${capability} / explicitly unsealed`,
      ).toBe(false);
      expect(
        portalModuleVerdict(capability, gatesWith({ continuity_box: "NOT_ENTITLED" }), {
          continuityBoxSealed: true,
        }).ok,
        `${capability} / sealed`,
      ).toBe(true);
    }
  });

  it("a sealed box survives a lapsed plan on BOTH modules", () => {
    // The failure §5 exists to forbid: a continuity promise that seals
    // itself when the card expires. A lapse can drop the portal
    // entitlement along with the box's own.
    for (const capability of CONTINUITY) {
      expect(
        portalModuleVerdict(
          capability,
          gatesWith({ portal: "NOT_ENTITLED", continuity_box: "NOT_ENTITLED" }),
          { continuityBoxSealed: true },
        ).ok,
        capability,
      ).toBe(true);
    }
  });

  it("a sealed box does NOT survive the tenant's own portal off-switch", () => {
    // Gate 3 is a `TenantPreference` an operator SET, not a lapse. A
    // tenant that deliberately switches the portal off has said
    // something the product must obey — and serving contacts through an
    // off switch is the exact failure module-gates.ts exists to prevent.
    // §5 waives gate 3 for the BOX's own module, and that is honoured.
    for (const capability of CONTINUITY) {
      expect(
        portalModuleVerdict(capability, gatesWith({ portal: "DISABLED_BY_TENANT" }), {
          continuityBoxSealed: true,
        }),
        `${capability} / portal switched off`,
      ).toEqual({ ok: false, reason: "DISABLED_BY_TENANT", detail: "portal" });
      expect(
        portalModuleVerdict(capability, gatesWith({ continuity_box: "DISABLED_BY_TENANT" }), {
          continuityBoxSealed: true,
        }).ok,
        `${capability} / continuity_box switched off`,
      ).toBe(true);
    }
  });

  it("a kill-switch bites a sealed box, because gate 1 is engineering's", () => {
    for (const capability of CONTINUITY) {
      expect(
        portalModuleVerdict(capability, gatesWith({ continuity_box: "FEATURE_DISABLED" }), {
          continuityBoxSealed: true,
        }),
        capability,
      ).toEqual({ ok: false, reason: "FEATURE_DISABLED", detail: "continuity_box" });
    }
  });

  it("the exemption never reaches a non-continuity capability", () => {
    // `continuityBoxSealed` is not a master key.
    for (const capability of PORTAL_CAPABILITIES) {
      if (capability.startsWith("portal.continuity.")) continue;
      expect(
        portalModuleVerdict(capability, gatesWith({ portal: "NOT_ENTITLED" }), {
          continuityBoxSealed: true,
        }).ok,
        capability,
      ).toBe(false);
    }
  });

  it("fails closed on a capability the table does not know", () => {
    // Exported, so it must hold on its own rather than lean on
    // `portalPrincipalVerdict` having run first.
    expect(portalModuleVerdict("portal.everything" as PortalCapability, allGates("ok"))).toEqual({
      ok: false,
      reason: "FORBIDDEN",
      detail: "unknown portal capability",
    });
  });

  it("denies when the gates were never resolved — including on the sealed-box path", () => {
    for (const capability of PORTAL_CAPABILITIES) {
      expect(portalModuleVerdict(capability, undefined), capability).toEqual({
        ok: false,
        reason: "FORBIDDEN",
        detail: "module gates unresolved: portal",
      });
    }
    // A partial map is the shape a refactor produces; it must deny too,
    // and it must deny as a bug rather than as a commercial state.
    const partial = { portal: "ok" } as unknown as PortalModuleGates;
    expect(portalModuleVerdict("portal.hours.view", partial)).toEqual({
      ok: false,
      reason: "FORBIDDEN",
      detail: "module gates unresolved: time",
    });
    expect(portalModuleVerdict("portal.continuity.download", partial)).toEqual({
      ok: false,
      reason: "FORBIDDEN",
      detail: "module gates unresolved: continuity_box",
    });
  });
});

describe("computePortalModuleGates", () => {
  const empty = new Set<string>();

  it("is all-ok for the everything-on default document", () => {
    expect(
      computePortalModuleGates({
        entitlements: parseEntitlements({}),
        flagOff: empty,
        preferenceOff: empty,
      }),
    ).toEqual(allGates("ok"));
  });

  it("covers every module the portal can require, and only those", () => {
    const gates = computePortalModuleGates({
      entitlements: parseEntitlements({}),
      flagOff: empty,
      preferenceOff: empty,
    });
    expect(Object.keys(gates).sort()).toEqual([...PORTAL_MODULES].sort());
  });

  it("orders the three gates 1 → 2 → 3, so the kill-switch dominates", () => {
    const ents = parseEntitlements({ modules: { portal: false } });
    // Entitlement off AND flag off ⇒ FEATURE_DISABLED: a rollback switch
    // that only works for entitled tenants is not a rollback switch.
    expect(
      computePortalModuleGates({
        entitlements: ents,
        flagOff: new Set(["portal"]),
        preferenceOff: new Set(["portal"]),
      }).portal,
    ).toBe("FEATURE_DISABLED");
    expect(
      computePortalModuleGates({
        entitlements: ents,
        flagOff: empty,
        preferenceOff: new Set(["portal"]),
      }).portal,
    ).toBe("NOT_ENTITLED");
    expect(
      computePortalModuleGates({
        entitlements: parseEntitlements({}),
        flagOff: empty,
        preferenceOff: new Set(["portal"]),
      }).portal,
    ).toBe("DISABLED_BY_TENANT");
  });

  it("treats a missing module key as NOT entitled", () => {
    // `!== true`, not `=== false`: a document whose `modules` object has
    // lost a key must not read as permitted. (The zod schema defaults
    // every key to true, so this is the guard for a future version whose
    // parse succeeds with a narrower shape.)
    const ents = { modules: {} } as unknown as Parameters<
      typeof computePortalModuleGates
    >[0]["entitlements"];
    const gates = computePortalModuleGates({ entitlements: ents, flagOff: empty, preferenceOff: empty });
    for (const m of PORTAL_MODULES) expect(gates[m], m).toBe("NOT_ENTITLED");
  });

  it("gates each module independently", () => {
    const gates = computePortalModuleGates({
      entitlements: parseEntitlements({ modules: { vault: false } }),
      flagOff: new Set(["time"]),
      preferenceOff: new Set(["work"]),
    });
    expect(gates).toEqual(
      gatesWith({ vault: "NOT_ENTITLED", time: "FEATURE_DISABLED", work: "DISABLED_BY_TENANT" }),
    );
  });
});
