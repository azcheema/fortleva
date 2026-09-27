import { fail } from "@/lib/domain-error";

/**
 * SIGN-OFF'S VOCABULARY — the LEAF half of `./signoff.ts`, split out so
 * the portal's client island can import it: `signoff.ts` opens a system
 * transaction to announce a decision, which no `"use client"` module may
 * pull in. Nothing here touches a database.
 */

export type SignoffDecision = "APPROVED" | "CHANGES_REQUESTED";

/**
 * THE ANCHORS a "Waiting on you" row jumps to — the rail entry of a
 * shipped version and the file row of a deliverable, where the ONE
 * sign-off control for that subject lives (`project-view.tsx` says why
 * the card links rather than draws it). Deterministic, so the View-as
 * twin renders the same bytes.
 */
export const versionAnchor = (versionId: string): string => `version-${versionId}`;
export const fileAnchor = (documentId: string): string => `file-${documentId}`;

/**
 * The remount key for the portal's sign-off island — the decision as
 * the server last rendered it, so a revalidation that answers an ask
 * replaces the island's local state (`sign-off.tsx` says why). It lives
 * HERE, in a module with no directive, because the server components
 * that key the island CALL it: a function exported from the island's
 * own `"use client"` file would reach them as a client reference and
 * throw on call (AGENTS.md's standing trap, met in this slice).
 */
export const signOffKey = (
  id: string,
  approval: { readonly status: string; readonly decidedAt: Date | null },
): string => `${id}:${approval.status}:${approval.decidedAt?.toISOString() ?? ""}`;

/**
 * The most a contact may write with a decision. A note is the client's
 * own words to the agency about what to change; it is not a document,
 * and it is projected back to every contact of the client on the rail.
 */
export const SIGNOFF_NOTE_MAX = 2000;

export type SignoffInput = {
  readonly decision: SignoffDecision;
  /** Required on CHANGES_REQUESTED, optional on APPROVED; trimmed; null when empty. */
  readonly note: string | null;
};

const DECISIONS: ReadonlySet<string> = new Set<SignoffDecision>(["APPROVED", "CHANGES_REQUESTED"]);

/**
 * THE INPUT IS PARSED BEFORE ANYTHING IS AUTHORIZED, the one place the
 * portal's writers deviate from "authorize first" (`createPortalRequest`
 * records why): a missing note or an unknown decision is a fact about
 * what the reader typed, may be reported plainly (`INVALID_INPUT` is on
 * the disclosable list), and refusing it here means a bad form never
 * opens a transaction. "Request changes" with nothing written is
 * refused: an ask to change something that says nothing is not
 * something the agency can act on, and the control asks for the words
 * before it offers the button.
 */
export function parseSignoffInput(raw: { readonly decision: unknown; readonly note: unknown }): SignoffInput {
  const decision =
    typeof raw.decision === "string" && DECISIONS.has(raw.decision) ? (raw.decision as SignoffDecision) : null;
  if (!decision) fail("INVALID_INPUT", "decision");
  const text = typeof raw.note === "string" ? raw.note.trim() : "";
  if (text.length > SIGNOFF_NOTE_MAX) fail("INVALID_INPUT", "note too long");
  if (decision === "CHANGES_REQUESTED" && text.length === 0) fail("INVALID_INPUT", "note required");
  return { decision: decision!, note: text.length > 0 ? text : null };
}
