import type { NotificationKind } from "./catalog";

/**
 * Kind → the `inbox.kind.*` message key that names it.
 *
 * An EXPLICIT map rather than an interpolated key, and its own module
 * rather than a constant inside the client component, for two reasons:
 * adding a kind to the catalog without copy for it is then a TYPE error
 * (the same discipline `src/notify/templates.ts` uses for the email
 * subjects), and `kind-copy.test.ts` can check these keys against the
 * REAL catalogues. What that test adds over `src/i18n/messages.test.ts`
 * — which already pins en/sv key PARITY and non-empty values — is the
 * coupling to the kind catalog: copy missing from BOTH catalogues, and
 * a label left behind by a kind that was removed.
 *
 * The values are a closed union, not `string`. The union alone is only
 * half the guarantee: `next-intl` is typed against `en.json` here
 * (`src/i18n/global.d.ts`), so the call site must interpolate these
 * WITHOUT an `as` cast — with one, a typo compiles cleanly and reaches
 * the page as a raw key. Interpolating a closed union into `t()` is
 * already valid; the cast buys nothing and costs the check.
 */
type KindCopyKey = "assigned" | "mentioned" | "commented" | "budgetThreshold" | "requestReceived";

export const KIND_MESSAGE_KEY: Record<NotificationKind, KindCopyKey> = {
  "work_item.assigned": "assigned",
  "comment.mentioned": "mentioned",
  "work_item.commented": "commented",
  "work_item.request_received": "requestReceived",
  "budget.threshold_reached": "budgetThreshold",
};

/** The label for a row whose kind this build does not know — a row
 * written by a newer deploy still renders rather than going blank. */
export const GENERIC_COPY_KEY = "generic";

/**
 * Every key the inbox can ask the `inbox.kind` namespace for.
 *
 * DEDUPLICATED, because two kinds may legitimately share one label —
 * without the Set, that state fails the "no leftover key" assertion
 * with a message naming the wrong problem. `Record<NotificationKind, …>`
 * already forces the map to cover every kind, so the values are the
 * whole answer; going back through `NOTIFICATION_KINDS` would only add
 * an unchecked cast.
 */
export const ALL_KIND_COPY_KEYS = [
  ...new Set<KindCopyKey | typeof GENERIC_COPY_KEY>(Object.values(KIND_MESSAGE_KEY)),
  GENERIC_COPY_KEY,
] as const;
