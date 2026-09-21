/**
 * THE REQUEST FORM'S TWO LENGTH CAPS, AND NOTHING ELSE.
 *
 * A LEAF MODULE THAT IMPORTS NOTHING, which is the whole reason it
 * exists as a file rather than as two lines in `requests.ts`. The
 * portal's request form is a `"use client"` component and needs these
 * numbers for its `maxLength` attributes; importing them from
 * `@/modules/work` pulled the barrel into the browser graph, and the
 * barrel re-exports `portal-writes.ts`, which imports `withTenant`,
 * which imports the Prisma client, which imports `pg`. **The build
 * failed outright** — `Module not found: Can't resolve 'util/types'`,
 * Node's own module, reached from a Client Component Browser trace.
 *
 * That is the second time this exact shape has bitten in two slices.
 * Slice 48's code review found a `"use client"` component importing
 * `@/config` and shipping the env schema, the portal auth secret's
 * derivation and a `crypto-browserify` polyfill into a **444 KB** chunk
 * — and that one SUCCEEDED, which made it invisible. This one failed
 * loudly only because `pg` reaches for a Node builtin the browser has no
 * shim for. **The lesson is the same either way: a client component may
 * import only from a module whose own import graph it could recite.**
 * The answer both times is a leaf: `src/config/view-as.ts` there, this
 * file here, re-exported from the server-side module so nothing else has
 * to know.
 *
 * The caps themselves are deliberately far below the description cap the
 * member editor enforces: this is a form field on the least-trusted
 * surface in the product, and the row it writes is read back by
 * employees. A longer body is REFUSED rather than truncated — silently
 * storing less than the client typed would let them believe they had
 * said something they had not.
 */

/** One line: what the client needs, in the short version. */
export const REQUEST_TITLE_MAX = 200;

/** The optional paragraph under it. */
export const REQUEST_BODY_MAX = 4000;
