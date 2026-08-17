/**
 * One grid, shared by the column headers (a server component) and the
 * contact rows (a client component) — so the two can never drift out of
 * alignment.
 *
 * It lives in a module of its own, with NO "use client" directive, on
 * purpose. Every export of a "use client" module is replaced by a
 * client REFERENCE when a server component imports it: interpolating
 * one into a template literal stringifies the reference stub, and the
 * class attribute ends up carrying
 * `function(){throw Error("Attempted to call CONTACT_GRID()…")}`
 * instead of the grid. The header then collapses to a single column and
 * its six labels stack on top of each other inside a 32px row — which
 * is exactly what it did.
 *
 * It carries the COLUMNS only, not `display`: the header is hidden
 * below sm and the rows never are, so each consumer says `grid` or
 * `hidden sm:grid` for itself. A shared `grid` here would have fought
 * the header's `hidden` at equal specificity.
 */
/**
 * EMAIL GETS THE WIDEST TRACK. It is the contact's primary identifier
 * and the one value a reader actually needs to copy; on five equal
 * tracks it was clipped mid-address inside a 32px input
 * (`astrid-c25f863b@t`) with no ellipsis and no title. Portal profile
 * is demoted to the narrowest text track — it is a setting, not a
 * fact about the person — and the last track stays FIXED for the
 * status chip plus the row's actions trigger. Fixed, not `auto`,
 * because the header is a separate grid: an auto track would size
 * itself from the word "Status" and the two rows would stop lining up.
 */
export const CONTACT_GRID =
  "grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)_11rem]";
