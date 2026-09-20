import type { DenialReason } from "@/authz/errors";
import type { Entitlements } from "@/entitlements/resolver";

import {
  PORTAL_CAPABILITY_DEFS,
  PORTAL_MODULES,
  isPortalCapability,
  profileHolds,
  type PortalCapability,
  type PortalModule,
} from "./capabilities";

/**
 * `authorizePortal()`'s decisions as PURE functions over plain values —
 * the contact-plane twin of `src/db/portal-identity-policy.ts` and
 * `src/auth/portal-gate.ts`, and importless for the same measured
 * reason: the unit suite runs before `migrate deploy`, with no
 * `DATABASE_URL`, so a rule that needs a connection is a rule that gets
 * exercised once a fortnight instead of on every push. Everything here
 * is decided with no connection, no cookie and no Better Auth;
 * `policy.test.ts` walks the whole matrix that way.
 *
 * The two DB-dependent steps of the §8 pipeline — "the resource belongs
 * to my client" and "it is CLIENT_VISIBLE on a portal-enabled project" —
 * are NOT here, because they are not decidable from values: they are a
 * row read under the contact principal, where the `portal_gate` RLS
 * policy is the authority. `authorize.ts` sequences the three.
 */

/** A denial with its reason, or a pass. Never a bare boolean: the reason
 * is what the audit row and the test matrix key on. */
export type PortalVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DenialReason; readonly detail: string };

const OK: PortalVerdict = { ok: true };
const no = (reason: DenialReason, detail: string): PortalVerdict => ({ ok: false, reason, detail });

/**
 * The resolved state of gates 1–3 for one module (AUTHZ.md §5). The
 * non-"ok" values ARE the denial reasons, which is why they are spelled
 * as `DenialReason` members rather than as a private enum.
 */
export type PortalModuleGateState = Extract<
  DenialReason,
  "FEATURE_DISABLED" | "NOT_ENTITLED" | "DISABLED_BY_TENANT"
> | "ok";

/**
 * Gates 1–3 for every module the portal can require, resolved once per
 * request. A FULL record, never a partial one: a missing key must be a
 * type error rather than an accidental pass, and `portalModuleVerdict`
 * denies anyway if one is absent at runtime.
 */
export type PortalModuleGates = Readonly<Record<PortalModule, PortalModuleGateState>>;

/**
 * Gates 1–3, computed from the tenant's own configuration.
 *
 * Gate 1 (kill-switch) fails OPEN on a MISSING flag row, exactly as
 * `flagEnabled` does — flags gate rollouts, they are not authorization.
 * The caller must therefore pass the set of modules whose flag is
 * positively OFF, never "the flags it managed to read": on the portal
 * plane those two differ, because `feature_flag` carries `portal_deny`
 * and a contact-principal read of it returns zero rows, which is
 * indistinguishable from "no flag exists". That is precisely why the
 * read happens where it does — see `module-gates.ts`.
 *
 * Gates 2 and 3 fail CLOSED in the only sense available to them: the
 * entitlement is read from the parsed document (absent module key ⇒
 * `undefined` ⇒ not entitled), and a preference is OFF only when a row
 * says so (an absent preference row means enabled, per AUTHZ.md §5).
 */
export const computePortalModuleGates = (input: {
  readonly entitlements: Entitlements;
  /** Modules whose `module.<key>` flag resolves to OFF for this tenant. */
  readonly flagOff: ReadonlySet<string>;
  /** Modules whose `module.<key>.enabled` preference row says `false`. */
  readonly preferenceOff: ReadonlySet<string>;
}): PortalModuleGates => {
  const out = {} as Record<PortalModule, PortalModuleGateState>;
  for (const m of PORTAL_MODULES) {
    out[m] = input.flagOff.has(m)
      ? "FEATURE_DISABLED"
      : input.entitlements.modules[m] !== true
        ? "NOT_ENTITLED"
        : input.preferenceOff.has(m)
          ? "DISABLED_BY_TENANT"
          : "ok";
  }
  return out;
};

/**
 * Steps 1–2 of the §8 pipeline: **the contact is active and was
 * invited**, then **the capability is in its profile**.
 *
 * Every input is optional and every one of them DENIES when absent —
 * the `portalGateDecision` discipline. The values are meant to come
 * from the `contact` ROW read inside the transaction, not from the
 * session: a session is a snapshot, and a contact suspended two minutes
 * ago must not still be acting on one.
 *
 * ORDER. AUTHZ.md §5 evaluates 1→2→3→4 for members; §8 spells the
 * portal pipeline out with the module gates LAST, and that is the order
 * implemented (see `authorize.ts`). The gates are AND-ed so the outcome
 * is identical either way; what the order fixes is which reason comes
 * back, and on this plane the §8 order is the better one — a contact
 * who is not allowed anyway never learns whether their agency's plan
 * includes invoicing.
 *
 * `invitedAt` is a STRENGTHENING of "was invited" and it is stated here
 * because it is a decision, not an implementation detail. §8's own gloss
 * ("no self-signup path exists in code") makes the invariant a property
 * of the codebase; requiring the stamp makes it a property of the ROW,
 * so an activation path that forgets to record the invitation is refused
 * rather than trusted. Anything that activates a contact must set it.
 */
export const portalPrincipalVerdict = (input: {
  readonly capability?: unknown;
  readonly profile?: unknown;
  readonly portalStatus?: unknown;
  readonly invitedAt?: Date | string | null;
}): PortalVerdict => {
  // An unknown capability is a CONFIG error, not a user error, and is
  // denied loudly for the same reason `authorize()` denies an unknown
  // permission code: a typo must never read as "allowed".
  if (!isPortalCapability(input.capability)) {
    return no("FORBIDDEN", "unknown portal capability");
  }
  // Compared to the literal ACTIVE, never to "not revoked": NO_ACCESS,
  // INVITED, SUSPENDED, REVOKED and any value this code has never heard
  // of must all deny.
  if (input.portalStatus !== "ACTIVE") return no("FORBIDDEN", "contact is not ACTIVE");
  if (!input.invitedAt) return no("FORBIDDEN", "contact was never invited");
  if (!profileHolds(input.profile, input.capability)) {
    return no("FORBIDDEN", "capability not in profile");
  }
  return OK;
};

/**
 * Step 5: gates 1–3 for every module the capability depends on, in the
 * order the capability declares them (`portal` first, then the parent),
 * so the reason names the outermost thing that is off.
 *
 * Unresolved gates DENY, and deny as a config error rather than as
 * `FEATURE_DISABLED`: "we failed to resolve the tenant's entitlements"
 * and "engineering switched this off" are different events and only one
 * of them is a bug.
 */
export const portalModuleVerdict = (
  capability: PortalCapability,
  gates: PortalModuleGates | undefined,
  opts?: {
    /**
     * Proof that the continuity box is SEALED. Defaults to FALSE, so the
     * §5 exemption does not apply until a caller establishes the
     * precondition §5 states ("once a box is SEALED"). Phase 8 passes it
     * after reading the box's state; nothing else ever should.
     */
    readonly continuityBoxSealed?: boolean;
  },
): PortalVerdict => {
  const def = PORTAL_CAPABILITY_DEFS[capability];
  // Fails closed on a capability the table does not know, rather than
  // throwing a TypeError on `def.modules`. `authorizePortal` cannot
  // reach this — `portalPrincipalVerdict` has already refused an
  // unknown capability — but this function is exported, and a guard
  // that depends on its only current caller is not a guard.
  if (!def) return no("FORBIDDEN", "unknown portal capability");
  for (const m of def.modules) {
    const state = gates?.[m];
    if (state === undefined) return no("FORBIDDEN", `module gates unresolved: ${m}`);
    if (state === "ok") continue;
    // The sealed-box exemption (AUTHZ.md §5) — conditional, and narrower
    // for `portal` than for `continuity_box`. See capabilities.ts for
    // both halves of the reasoning; in short: gate 1 is engineering's
    // and always bites; gate 2 is commercial and is what §5 exists to
    // survive; gate 3 is an operator's deliberate switch, which the
    // product obeys for `portal` and waives only for the box's own
    // module, exactly as §5 words it.
    if ("sealedBoxExempt" in def && opts?.continuityBoxSealed === true) {
      if (state === "NOT_ENTITLED") continue;
      if (state === "DISABLED_BY_TENANT" && m === "continuity_box") continue;
    }
    return no(state, m);
  }
  return OK;
};
