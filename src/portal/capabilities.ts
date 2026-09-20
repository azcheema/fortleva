import type { Module } from "@/authz/catalog";

/**
 * THE PORTAL CAPABILITY UNIVERSE (AUTHZ.md §8) — a hardcoded TypeScript
 * table, deliberately: not rows in `Permission`, not tenant-customizable,
 * not extensible at runtime. The portal is the least-trusted surface in
 * the product, so its authorization surface is frozen in code and moves
 * only by a deploy.
 *
 * It is the THIRD of three namespaces that never mix (AGENTS.md):
 * permission codes are `resource:verb`, audit actions are `entity.verb`,
 * portal capabilities are `portal.area.verb`. The §3.1 immutability rule
 * (codes are forever, deprecate never rename) does NOT apply here — this
 * union is code with no stored representation, which is why retiring
 * `portal.issue.*` in favour of `portal.work_item.*` in 2026-08-16 was a
 * compile-time refactor with no data migration.
 *
 * This file is PURE and importless by construction (the one import is a
 * type, erased at build). `policy.ts` decides over it without a database,
 * for the reason `src/auth/portal-gate.ts` records: a rule that can only
 * be exercised against a connection is a rule that gets tested rarely.
 */

/**
 * The entitlement modules a portal capability can depend on — a subset
 * of the ten in `src/authz/catalog.ts`, spelled identically because gate
 * composition is a literal lookup (`module.<key>` flag key,
 * `modules.<key>` entitlement key, `module.<key>.enabled` preference
 * key). `satisfies readonly Module[]` is what keeps the two lists from
 * drifting: a typo here is a type error, not a silently-open gate.
 */
export const PORTAL_MODULES = [
  "portal",
  "work",
  "time",
  "vault",
  "invoicing",
  "contracts",
  "continuity_box",
] as const satisfies readonly Module[];

export type PortalModule = (typeof PORTAL_MODULES)[number];

type CapabilityDef = {
  /**
   * Every module that must pass gates 1–3 for this capability. `portal`
   * is on every one of them (AUTHZ.md §8: "the `portal` module entitled
   * + preferred, plus the capability's parent module") — stated per row
   * rather than implied, so the table reads as the whole truth.
   */
  readonly modules: readonly PortalModule[];
  /**
   * The continuity-box exemption (AUTHZ.md §5, product-defining): "once
   * a box is SEALED, the open-request → open → download path ignores
   * gates 2 and 3." A continuity promise that seals itself when the card
   * expires is not a continuity promise.
   *
   * IT IS A CONDITIONAL EXEMPTION AND THE CONDITION IS ENFORCED, which
   * the first cut of this file got wrong in two ways that two fresh
   * reviews caught independently:
   *
   *  - **"Once a box is SEALED" is a precondition, not scene-setting.**
   *    The first cut applied the exemption unconditionally, so a tenant
   *    that had never bought `continuity_box` and had no box at all
   *    still passed gate 2 for all three capabilities — the commercial
   *    gate on continuity was simply not enforced for contacts, ever.
   *    The exemption now applies only when the caller PROVES the box is
   *    sealed (`continuityBoxSealed`, default false ⇒ no exemption), so
   *    Phase 8 cannot forget it: until something passes it, these
   *    capabilities are gated like every other one.
   *  - **Which gates, for which module.** §5 exempts gates 2 and 3 for
   *    `continuity_box`, and that is honoured exactly. For the `portal`
   *    module only gate 2 is exempt: a lapsed plan can drop the portal
   *    entitlement and seal the box with it, which §5 forbids — but
   *    gate 3 is a `TenantPreference` an operator SET, and a tenant that
   *    deliberately switches the portal off has said something the
   *    product must obey. The first cut exempted both and would have
   *    kept serving contacts through an off switch, which is the exact
   *    failure `module-gates.ts` exists to prevent.
   */
  readonly sealedBoxExempt?: true;
};

/**
 * The v1 complete set. `portal.report.view` is the one row of AUTHZ.md
 * §8's table that is NOT here: it is marked v2 there, and a capability
 * present in the union is a capability `CONTACT_PRIMARY` holds (below),
 * so listing it early would grant it early. Add it with the feature.
 */
export const PORTAL_CAPABILITY_DEFS = {
  // ── Core portal surfaces: no parent module (projects, documents and
  // versions are `core`, always on) ────────────────────────────────
  "portal.project.view": { modules: ["portal"] },
  "portal.version.approve": { modules: ["portal"] },
  "portal.document.view": { modules: ["portal"] },
  "portal.document.download": { modules: ["portal"] },
  "portal.deliverable.approve": { modules: ["portal"] },
  // ── work: items, requests, comments, updates, timeline ───────────
  // `ProjectUpdate` rides on `work` (AUTHZ.md §5: there is no separate
  // `updates` key), and so does the derived timeline.
  "portal.work_item.view": { modules: ["portal", "work"] },
  "portal.work_item.act": { modules: ["portal", "work"] },
  "portal.request.create": { modules: ["portal", "work"] },
  "portal.comment.create": { modules: ["portal", "work"] },
  "portal.update.view": { modules: ["portal", "work"] },
  "portal.timeline.view": { modules: ["portal", "work"] },
  // ── time: the hours widget and published TimeReport snapshots ────
  "portal.hours.view": { modules: ["portal", "time"] },
  // ── vault (3V) ───────────────────────────────────────────────────
  "portal.credential.submit": { modules: ["portal", "vault"] },
  "portal.share_link.view": { modules: ["portal", "vault"] },
  // ── money (P4) ───────────────────────────────────────────────────
  "portal.invoice.view": { modules: ["portal", "invoicing"] },
  "portal.invoice.pay": { modules: ["portal", "invoicing"] },
  "portal.contract.view": { modules: ["portal", "contracts"] },
  "portal.contract.sign": { modules: ["portal", "contracts"] },
  // ── continuity box (P8) — see sealedBoxExempt above ──────────────
  "portal.continuity.view_status": { modules: ["portal", "continuity_box"], sealedBoxExempt: true },
  "portal.continuity.request_open": { modules: ["portal", "continuity_box"], sealedBoxExempt: true },
  "portal.continuity.download": { modules: ["portal", "continuity_box"], sealedBoxExempt: true },
} as const satisfies Record<string, CapabilityDef>;

export type PortalCapability = keyof typeof PORTAL_CAPABILITY_DEFS;

/** The union as a list. Insertion-ordered; `capabilities.test.ts` pins it. */
export const PORTAL_CAPABILITIES = Object.keys(PORTAL_CAPABILITY_DEFS) as readonly PortalCapability[];

const CAPABILITY_SET: ReadonlySet<string> = new Set<string>(PORTAL_CAPABILITIES);

/** Membership test that accepts an untrusted string. */
export const isPortalCapability = (value: unknown): value is PortalCapability =>
  typeof value === "string" && CAPABILITY_SET.has(value);

/**
 * Contact profiles — fixed bundles over the allowlist, selected per
 * contact by staff holding `client:manage_contacts`. Per-contact
 * capability toggles WITHIN the allowlist are v2; tenant-defined portal
 * roles are on the skip list.
 *
 * `CONTACT_PRIMARY` is derived as "every capability" because that is
 * what AUTHZ.md §8 says it is, and because a bundle written out by hand
 * drifts from the table above it. The cost of deriving is that a new row
 * in the table grants itself to every primary contact — which is why
 * `capabilities.test.ts` pins the resolved PRIMARY list explicitly: the
 * derivation is a convenience, the pin is the control.
 *
 * `CONTACT_COLLABORATOR` is written out: no money, no signatures, no
 * continuity, no hours, no deliverable sign-off, no version approval.
 */
export const PORTAL_PROFILES = {
  CONTACT_PRIMARY: PORTAL_CAPABILITIES,
  CONTACT_COLLABORATOR: [
    "portal.project.view",
    "portal.document.view",
    "portal.document.download",
    "portal.work_item.view",
    "portal.work_item.act",
    "portal.request.create",
    "portal.comment.create",
    "portal.update.view",
    "portal.timeline.view",
    "portal.credential.submit",
    "portal.share_link.view",
  ],
} as const satisfies Record<string, readonly PortalCapability[]>;

/**
 * The profile names, which are also the `ContactPortalProfile` enum
 * values in the schema. `CONTACT_FINANCE` is v2 and is absent from both.
 */
export type PortalProfile = keyof typeof PORTAL_PROFILES;

const PROFILE_SETS: Readonly<Record<PortalProfile, ReadonlySet<string>>> = {
  CONTACT_PRIMARY: new Set<string>(PORTAL_PROFILES.CONTACT_PRIMARY),
  CONTACT_COLLABORATOR: new Set<string>(PORTAL_PROFILES.CONTACT_COLLABORATOR),
};

export const isPortalProfile = (value: unknown): value is PortalProfile =>
  typeof value === "string" && Object.hasOwn(PROFILE_SETS, value);

/**
 * Does this profile hold this capability? FAILS CLOSED on anything it
 * does not positively recognise — an unknown profile holds nothing, and
 * an unknown capability is held by nobody.
 */
export const profileHolds = (profile: unknown, capability: unknown): boolean =>
  isPortalProfile(profile) && isPortalCapability(capability)
    ? PROFILE_SETS[profile].has(capability)
    : false;
