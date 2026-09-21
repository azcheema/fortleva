/**
 * View-as-Contact's route prefix and the internal request header the
 * proxy stamps on it (Phase 3 slice 5).
 *
 * **A LEAF MODULE, AND THAT IS THE WHOLE POINT OF THE FILE.** These two
 * constants are needed by three server-side layers — `src/proxy.ts` in
 * the middleware runtime, `src/i18n/resolve.ts` in the render,
 * `src/clients/view-as-context.ts` — and by ONE `"use client"`
 * component, the button that enters the mode. They started out in
 * `./index.ts`, which was a mistake a code review measured rather than
 * argued: `src/config/index.ts` imports `node:crypto`, runs
 * `envSchema.parse(process.env)` at module scope and derives
 * `portalAuthSecret` from `BETTER_AUTH_SECRET` there too, and Turbopack
 * tree-shakes EXPORTS but keeps top-level side effects. The result was a
 * 444 KB browser chunk carrying the env schema's field names
 * (`BETTER_AUTH_SECRET`, `R2_SECRET_ACCESS_KEY`…), the secret-derivation
 * expression and a full `crypto-browserify` polyfill, evaluated on every
 * load of the Project → Portal page.
 *
 * No secret VALUE leaked — Next's browser `process.env` shim carries
 * only `NEXT_PUBLIC_*`, so the derivation computed over `undefined` —
 * and that is exactly why it would have stayed invisible. The failure
 * mode was one edit away in each direction: add a REQUIRED field to
 * `envSchema` and the chunk throws `ZodError` at module evaluation, so
 * the tab stops hydrating with nothing failing on the server; add a
 * `NEXT_PUBLIC_*` field and a real value ships.
 *
 * So: nothing in this file may import anything. No env, no `node:`
 * builtin, no sibling. `./index.ts` re-exports both names, so AGENTS.md's
 * "no hostnames or cookie names outside `src/config`" rule is satisfied
 * by either import path, and a server module can keep reaching for
 * `@/config` as it always did.
 */

/** The member-plane route group that renders a client's portal. */
export const VIEW_AS_PREFIX = "/view-as";

/**
 * Set by `src/proxy.ts` on that prefix and DELETED everywhere else.
 *
 * It answers one question — "is this request the View-as surface?" — and
 * it is consulted only to choose a locale and a time zone. It carries no
 * identity: WHICH contact comes from `Session.viewAsContactId`, and
 * whether the member may look through them is re-derived on every render
 * (`src/clients/view-as.ts`). It must be keyed on the ROUTE rather than
 * on the session pointer, because the pointer is per SESSION and a
 * member inside the mode in one tab must still read their own
 * application in their own language in another.
 */
export const VIEW_AS_HEADER = "x-flv-view-as";
