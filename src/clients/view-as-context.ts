import { headers } from "next/headers";
import { cache } from "react";

import { getMemberSession } from "@/auth/session";
import { VIEW_AS_HEADER } from "@/config";
import { getActiveMembership, mfaStateOf } from "@/members/tenant-context";

import { resolveViewAs, type ViewAsTarget } from "./view-as";

/**
 * VIEW-AS-CONTACT'S REQUEST CONTEXT — the member plane's answer to
 * `src/portal/context.ts`, and the seam two very different callers
 * share.
 *
 * `/view-as` needs it to know WHO it is rendering. `resolveLocale` and
 * `resolveTimeZone` need it to know whose language and clock to format
 * in, because a member's own session would otherwise decide both and
 * the page would not be byte-identical to anything (PLAN §0 named that
 * owed before the slice started). One memo answers both, so the
 * language a member is reading can never disagree with the contact the
 * page decided to draw.
 *
 * THE TWO QUESTIONS ARE SPLIT ON PURPOSE, and the split is the
 * correction to this file's first cut. `resolveViewAsTarget()` asks WHO
 * — session, pointer, permission, scope, admission — and knows nothing
 * about routes. `isViewAsRequest()` asks whether THIS REQUEST is the
 * View-as surface, and is a header read with no database in it. Only the
 * formatting needs both.
 *
 * Fusing them, which the first draft did, made the PAGE depend on a
 * header the proxy sets: a request that reached `/view-as` without it
 * would have redirected the member out of a mode they were legitimately
 * in, with nothing on screen to say why. Split, a missing header
 * degrades to "rendered in the member's language" — wrong, caught by
 * `proxy.test.ts` and by the byte comparison, and not a member staring
 * at a bounce they cannot explain.
 */

/**
 * Is this request the View-as surface? The proxy stamps the header on
 * that prefix and DELETES any inbound copy everywhere else
 * (`src/proxy.ts`), which is what makes it a fact this application owns
 * rather than a hint the client contributes to. It is only ever used to
 * choose a locale and a time zone — never to decide what may be read.
 */
export const isViewAsRequest = cache(
  async (): Promise<boolean> => (await headers()).get(VIEW_AS_HEADER) === "1",
);

/**
 * The contact this session is currently looking through, with the
 * member's right to do so RE-DERIVED — not read from the pointer.
 *
 * Null in every state that is not "inside the mode, still allowed":
 * no member session, no pointer, no active membership, the permission
 * revoked since entry, the client no longer in scope, the contact
 * suspended or never verified. Each of those means "render this the
 * member's own way", which is where every other page in the product
 * already is, so the failure direction is the safe one.
 *
 * Memoised per request with React's `cache` — never `unstable_cache`.
 * Entitlements are resolved per request and never baked into anything
 * long-lived (AUTHZ §5): the whole point of re-deriving on every render
 * is that a downgrade bites immediately, and a cache that outlived the
 * request would give that back.
 */
export const resolveViewAsTarget = cache(async (): Promise<ViewAsTarget | null> => {
  const session = await getMemberSession();
  if (!session) return null;
  // Declared on the session row; a column missing from the instance
  // schema reads `undefined`, which is the same as "not in the mode"
  // and therefore fails safe (`betterauth-plane-traps`).
  const pointer = (session.session as { viewAsContactId?: string | null }).viewAsContactId;
  if (!pointer) return null;

  const membership = await getActiveMembership(session);
  if (!membership) return null;

  return resolveViewAs(
    {
      tenantId: membership.tenantId,
      actor: { memberId: membership.memberId, mfa: mfaStateOf(session) },
    },
    pointer,
  );
});
