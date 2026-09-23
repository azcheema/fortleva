/**
 * THE CONTACT PORTAL-STATUS RULES THAT A BROWSER MODULE NEEDS — a LEAF
 * that imports nothing, for the reason `src/modules/work/request-limits.ts`
 * records: the Contacts tab is a `"use client"` module, and
 * `@/clients/contact-access` reaches `withTenant` → the Prisma client →
 * `pg` → `node:util/types`. Importing the rule from there would fail the
 * build outright.
 *
 * It exists so the surface and the service read the SAME list rather
 * than keeping two copies that drift. UI.md §3.1 is "hidden, never
 * disabled": a verb must be offered exactly where the service will
 * accept it, and the only way to guarantee that is for both to consult
 * one literal.
 */

/** Mirrors the `ContactPortalStatus` enum; stated here so this file imports nothing. */
export type ContactPortalStatusName = "NO_ACCESS" | "INVITED" | "ACTIVE" | "SUSPENDED" | "REVOKED";

/**
 * THE THREE STATES AN INVITATION MAY BE ISSUED FROM.
 *
 * `NO_ACCESS` is a first invitation. `INVITED` is a resend, which
 * supersedes the live token. `REVOKED` is a FRESH START after the agency
 * ended somebody's access (founder decision, 2026-09-23 —
 * OPEN_QUESTIONS C28): it used to be refused, which made "End access" an
 * absorbing state, since `deleteContact` also refuses anybody who has
 * written in the portal — so a returning client contact had no route to
 * portal access at all.
 *
 * `ACTIVE` and `SUSPENDED` are refused, and `inviteContact` says at
 * length why: re-inviting a paused contact would undo the pause through
 * a door that audits `contact.invited` and leaves `RESUME` throwing.
 */
export const INVITABLE_PORTAL_STATUSES = [
  "NO_ACCESS",
  "INVITED",
  "REVOKED",
] as const satisfies readonly ContactPortalStatusName[];

/** True when `inviteContact` will accept this row. Both planes ask this. */
export const isInvitableStatus = (status: ContactPortalStatusName): boolean =>
  (INVITABLE_PORTAL_STATUSES as readonly ContactPortalStatusName[]).includes(status);
