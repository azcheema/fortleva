import type { SignoffDecision } from "./signoff-vocabulary";

export { SIGNOFF_NOTE_MAX, parseSignoffInput } from "./signoff-vocabulary";
export type { SignoffDecision, SignoffInput } from "./signoff-vocabulary";
export { announceDecision } from "./signoff-announce";
export type { SignoffSubject } from "./signoff-announce";

/**
 * SIGN-OFF, THE PARTS BOTH KINDS SHARE (Phase 3, decision #7 v1-lite):
 * what a decision is, what a contact may type with it, what a
 * projection says about an ask, and how the agency is told.
 *
 * The two writers — `src/projects/portal-signoff.ts` for a shipped
 * version, `src/documents/portal-signoff.ts` for a shared deliverable —
 * are census writes, not brokers: each runs under the CONTACT principal
 * through `withCensusWrite`, and it is `portal_gate`, the named
 * `portal_approval_update` policy and the two BEFORE UPDATE triggers
 * (migration 20260927120000) that decide whether the row may change,
 * before any `where` in this code does. This module holds nothing that
 * touches either table: the vocabulary is `./signoff-vocabulary.ts` (a
 * leaf the client island may import) and the after-commit announcement
 * is `./signoff-announce.ts` (a system fan-out kept out of the portal
 * tripwire's scan, which follows every file that names the seam).
 */

/**
 * WHERE AN ASK STANDS, as a contact reads it on a shipped version or a
 * shared deliverable — the projections' shape (`listPortalTimeline`,
 * `listPortalDocuments`). `canDecide` is a boolean about the READER:
 * the ask is open AND this contact's profile holds the verb — so a
 * collaborator, who may read the rail but not sign anything, sees the
 * word "awaiting review" and no control. Never who was asked.
 */
export type PortalApprovalState = {
  readonly status: "NOT_REQUESTED" | "PENDING" | "APPROVED" | "CHANGES_REQUESTED";
  readonly decidedAt: Date | null;
  /** The deciding contact's own words, read back to every contact of the client. */
  readonly note: string | null;
  readonly canDecide: boolean;
};

/**
 * ONE OPEN ASK, for the home's "Waiting on you" card across projects —
 * the version's label or the deliverable's name, and the project it is
 * on so the row can link to the page where the control is.
 */
export type PortalPendingApproval =
  | {
      readonly kind: "version";
      readonly id: string;
      readonly version: string;
      readonly title: string | null;
      readonly project: { readonly id: string; readonly key: string; readonly name: string };
    }
  | {
      readonly kind: "deliverable";
      readonly id: string;
      readonly name: string;
      readonly versionNumber: number;
      /** Null for a deliverable shared with the company itself. */
      readonly project: { readonly id: string; readonly key: string; readonly name: string } | null;
    };

/**
 * What the two writers hand back — the row's decision as the database
 * holds it after the call, and whether THIS call made it. `changed:
 * false` is a real answer and not a failure: a double press on a slow
 * link is the ordinary way here, and the row's true state is what the
 * island adopts.
 */
export type SignoffResult = {
  readonly status: SignoffDecision;
  readonly decidedAt: Date;
  readonly note: string | null;
  readonly changed: boolean;
};

/**
 * HOW LONG A CONTACT'S DECISION MAY WAIT ON A LOCK. The same figure and
 * the same reasoning as the brokers' `PORTAL_LOCK_WAIT_MS`: a client
 * pressing a button is told to try again rather than parked behind
 * something big a member is running on the row.
 */
export const SIGNOFF_LOCK_WAIT_MS = 3000;
