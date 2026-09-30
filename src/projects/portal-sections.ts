/**
 * THE PORTAL'S SECTION SWITCHES (Phase 3 slice 80, founder decision C47):
 * which parts of a project the client's portal draws. Four, and hours is
 * not one of them — it has its own setting, `hoursSharingMode`.
 *
 * LAYOUT, NOT ACCESS CONTROL. A hidden section leaves the project's
 * one-screen page (`/portal/projects/[key]` and its View-as twin) and the
 * project's card on the client's home (C47's home answer, 2026-09-30),
 * and nothing else: whatever is shared stays reachable from a link, from
 * "Waiting on you" and from the Files page, and the all-updates page
 * still opens at its address (nothing on the portal links to it while
 * Updates is hidden).
 * Taking something away from a client is making it private. So no policy
 * reads these columns and no child row carries a copy — see the
 * migration `20260930120000_portal_sections`.
 *
 *  - `tasks`       the shared task list. The client's OWN REQUESTS stay
 *                  on it, whatever their state, with the agency's replies
 *                  (C47c) — the projection's `followSectionSwitches` says
 *                  which rows those are, because the column that knows is
 *                  never selected on the portal plane.
 *  - `updates`     the latest-update card, the health chip that is that
 *                  post's own, and the timeline's update entries.
 *  - `milestones`  the header's phase, next milestone and meter, and the
 *                  timeline's milestone entries.
 *  - `files`       the page's files section and the timeline's delivered
 *                  versions, with a deliverable's sign-off answer.
 *
 * No server import here: the Portal tab's client form draws its switches
 * from the same list the server action validates against.
 */
export const PORTAL_SECTIONS = ["tasks", "updates", "milestones", "files"] as const;

export type PortalSection = (typeof PORTAL_SECTIONS)[number];

/** Whether each section is drawn — every one `true` on a new project. */
export type PortalSections = { readonly [S in PortalSection]: boolean };

export const isPortalSection = (value: unknown): value is PortalSection =>
  typeof value === "string" && (PORTAL_SECTIONS as readonly string[]).includes(value);
