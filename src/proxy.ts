import { NextResponse, type NextRequest } from "next/server";

import { VIEW_AS_HEADER, VIEW_AS_PREFIX, planeForHost, sessionCookieName } from "@/config";

/**
 * Plane separation at the door (SECURITY.md §3.3, ARC-12). This layer
 * is deliberately THIN: it routes hosts to their plane and gates on
 * cookie PRESENCE. Authoritative session validation — including the
 * Session.plane row check and platformRole — happens server-side in
 * each route group's layout; a cookie name alone is never trusted.
 */

const OPS_PREFIX = "/ops";
/**
 * The platform plane's auth API. It belongs to the OPS host exactly as
 * `/ops` does, and until 2026-09-09 it belonged to neither.
 *
 * It matched no pass-through, so on the app host it fell through to the
 * generic branch below, whose only gate is the PRESENCE of a member
 * cookie — a value any scripted client can invent. The whole console
 * credential surface (sign-in, two-factor enable/verify, forget-password)
 * was therefore operable from the tenant origin, minting
 * `__Host-flv.platform` in a second, unmonitored namespace and defeating
 * every host-level control placed on ops. Better Auth's `trustedOrigins`
 * does not close it: its origin check stops a real browser, but a
 * scripted caller chooses its own Origin header.
 *
 * And on a REAL ops host the platform branch below swept it under
 * `/ops`, redirecting `/api/platform-auth/*` to
 * `/ops/api/platform-auth/*` — a route that does not exist. So the
 * console's auth API answered on the host that must not serve it, and
 * 404'd on the host that must. The two halves hid each other.
 */
const PLATFORM_API_PREFIX = "/api/platform-auth";
const PORTAL_PREFIX = "/portal";
/**
 * The PORTAL auth API. Host-scoped for the same reason the member one
 * above is, and the reason is not symmetry: cookie signatures do not
 * bind the cookie NAME (better-call signs the value alone) and the
 * member and platform instances share one BETTER_AUTH_SECRET (the
 * portal's is derived from it, `portalAuthSecret`), so any credential
 * surface reachable on the wrong host is a way to mint that plane's
 * cookies where the host's controls do not apply. The portal belongs
 * to the APP host — `planeForHost`: "os.naxdor.com serves tenant +
 * portal" — so the ops host must 404 it, exactly as it does /api/auth.
 */
const PORTAL_API_PREFIX = "/api/portal-auth";
/** The portal's own sign-in page: a contact with no session must be
 * able to reach it. */
const PORTAL_LOGIN = "/portal/login";
/**
 * INVITATION ACCEPTANCE, and it is a PREFIX rather than a `PUBLIC_PATHS`
 * entry because the token is a path segment — `PUBLIC_PATHS.has()` is an
 * exact match and could only ever exempt the bare `/portal/invite`,
 * leaving every real link bounced to a sign-in form for a credential the
 * invitee does not have yet. The trailing slash anchors it on a segment
 * boundary so `/portal/invitations` is not swept in with it.
 *
 * **THIS OPENS THE PAGE'S SERVER ACTION TOO**, because a Server Action
 * POSTs to its own pathname: the same branch that lets an invitee load
 * the page lets anyone POST to it. That is the sharp edge of the whole
 * slice and it is why the route rate-limits through `allowStrict` — the
 * one limiter in the product that holds without Upstash — rather than
 * through the fail-open `allow` its member-plane sibling uses.
 *
 * It stays BELOW the host/plane branches, so the ops host still sweeps
 * it under /ops and 404s it: a credential-setting surface must not be
 * reachable on the origin whose controls are meant to be tighter.
 */
const PORTAL_INVITE_PREFIX = "/portal/invite/";
/**
 * THE PORTAL'S PASSWORD RESET, both halves — the request form at the bare
 * path and the new-password form under it, whose token is a path segment
 * exactly like an invitation's. Somebody who has forgotten their password
 * has no session by definition, so gating either on the portal cookie
 * would bounce them to the sign-in form they have just come from.
 *
 * Two entries rather than one prefix without the slash, for the reason
 * `PORTAL_INVITE_PREFIX` gives: `startsWith("/portal/reset-password")`
 * would also exempt `/portal/reset-passwords` and anything else a later
 * route happens to begin with.
 *
 * Neither page has a Server Action — both forms call the portal auth API
 * from the browser — so, unlike the invitation's exemption, these open a
 * page render and nothing else. The same placement rule holds: below the
 * host/plane branches, so the ops host sweeps them under /ops and 404s.
 */
const PORTAL_RESET = "/portal/reset-password";
const PORTAL_RESET_PREFIX = `${PORTAL_RESET}/`;
// The PWA shell's manifest and worker (ARC-25) carry no tenant data and
// must be fetchable without a session; on the ops host they are swept
// under /ops/… by the platform branch and 404 there — un-installable.
// /api/jobs/run authenticates itself (JOBS_RUN_TOKEN header): a cron has
// no member cookie, so the presence gate must not redirect it to /login.
const PUBLIC_PATHS = new Set(["/login", "/signup", "/ops/login", PORTAL_LOGIN, PORTAL_RESET, "/api/health", "/api/jobs/run", "/manifest.webmanifest", "/sw.js"]);

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const host = request.headers.get("host") ?? "";
  const plane = planeForHost(host);

  /**
   * `VIEW_AS_HEADER` as THIS LAYER sees the pathname — which means
   * deleting whatever arrived under that name before setting it.
   *
   * The deletion is the load-bearing half. A header the proxy only ever
   * sets is a header a caller can also send: without it, a request to
   * any route carrying `x-flv-view-as: 1` would reach the render
   * indistinguishable from one this layer stamped. Setting it on the
   * view-as prefix and clearing it everywhere else makes the header a
   * fact this layer OWNS rather than a hint the client contributes to.
   *
   * `null` MEANS "NOTHING TO DO", and that is not an optimisation for
   * its own sake. The first cut cloned and re-emitted the entire inbound
   * header set on every request the proxy forwarded, for a feature that
   * matters on one prefix — and Next re-serialises those into
   * `x-middleware-request-*` response headers, cookies included, which
   * its own middleware documentation warns can reach 431 Request Header
   * Fields Too Large (code review). When the path is not view-as AND no
   * inbound copy is present, there is genuinely nothing to strip and
   * nothing to add, so the response carries no header override at all.
   */
  const isViewAsPath = pathname === VIEW_AS_PREFIX || pathname.startsWith(`${VIEW_AS_PREFIX}/`);
  const cleanedHeaders = (): Headers | null => {
    if (!isViewAsPath && !request.headers.has(VIEW_AS_HEADER)) return null;
    const headers = new Headers(request.headers);
    headers.delete(VIEW_AS_HEADER);
    if (isViewAsPath) headers.set(VIEW_AS_HEADER, "1");
    return headers;
  };

  /** Forward the request, with the header corrected if it needs correcting. */
  const pass = (): NextResponse => {
    const headers = cleanedHeaders();
    return headers ? NextResponse.next({ request: { headers } }) : NextResponse.next();
  };

  /**
   * The plane-boundary 404, sanitised the same way.
   *
   * A `rewrite` PROXIES the original request to the destination — Next's
   * own docs say so — so the three branches below used to forward a
   * forged `x-flv-view-as` into the `/404` render, which goes through the
   * root layout and therefore through `resolveLocale`. A code review
   * caught that three docblocks claimed the strip was universal when it
   * covered only the forwarding paths. What it could achieve was small
   * (a 404 page formatted in a contact's language, for a caller who
   * already holds the session, the pointer, the permission and the
   * scope) — but an absolute claim that is not true is the thing a later
   * reader relies on.
   */
  const deny404 = (): NextResponse => {
    const url = new URL("/404", request.url);
    const headers = cleanedHeaders();
    return headers ? NextResponse.rewrite(url, { request: { headers } }) : NextResponse.rewrite(url);
  };

  // The MEMBER auth API is host-scoped too, and this is not symmetry for
  // its own sake. Cookie SIGNATURES do not bind the cookie's NAME:
  // better-call signs the value alone (`signCookieValue(value, secret)`),
  // both instances derive from one BETTER_AUTH_SECRET, and both resolve
  // challenges against one `verification` table. So a
  // `better-auth.two_factor` value minted by the member instance replays
  // verbatim as `flv-ops.two_factor` at
  // `/api/platform-auth/two-factor/verify-totp` — which would stamp a
  // PLATFORM session `mfaVerifiedAt`, the artifact the console gate
  // treats as proof of a factor. `cookiePrefix` alone does NOT close
  // that, contrary to an earlier comment in src/auth/platform.ts; what
  // closes it is denying the member instance any way to mint a challenge
  // on the ops host in the first place.
  //
  // The dev-only storage stand-in is authorized by its own signed URL,
  // like R2, and is likewise app-plane only.
  if (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith(PORTAL_API_PREFIX) ||
    pathname.startsWith("/api/dev-storage")
  ) {
    return plane === "platform" ? deny404() : pass();
  }

  // The PLATFORM auth API is host-scoped exactly like the console it
  // serves. Checked BEFORE the platform branch below, so the ops host
  // does not sweep it under /ops and 404 its own sign-in.
  if (pathname.startsWith(PLATFORM_API_PREFIX)) {
    return plane === "platform" ? pass() : deny404();
  }

  if (plane === "platform") {
    // The ops host serves ONLY the platform console.
    if (!pathname.startsWith(OPS_PREFIX)) {
      const url = request.nextUrl.clone();
      url.pathname = `${OPS_PREFIX}${pathname === "/" ? "" : pathname}`;
      return NextResponse.redirect(url);
    }
  } else if (pathname.startsWith(OPS_PREFIX)) {
    // The app host never serves the console (separate host by decision 9)
    // — INCLUDING `/ops/login`, which used to be exempted here because it
    // is in PUBLIC_PATHS. That exemption gave the console a second front
    // door on the tenant origin: a login page with no console behind it
    // (`/ops` already 404s here), whose only purpose was to put the
    // platform credential form somewhere the ops host's controls do not
    // reach. PUBLIC_PATHS still lists it, because on the OPS host the
    // cookie gate below must not redirect the login page to itself.
    return deny404();
  }

  if (
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith("/invite/") ||
    pathname.startsWith(PORTAL_INVITE_PREFIX) ||
    pathname.startsWith(PORTAL_RESET_PREFIX)
  ) {
    return pass();
  }

  const cookieFor =
    pathname.startsWith(OPS_PREFIX)
      ? sessionCookieName("platform")
      : pathname.startsWith(PORTAL_PREFIX)
        ? sessionCookieName("portal")
        : sessionCookieName("member");

  if (!request.cookies.has(cookieFor)) {
    const url = request.nextUrl.clone();
    // Each plane bounces to ITS OWN login. Before the portal arm
    // existed, a contact opening a bookmarked /portal/... URL with an
    // expired cookie was sent to the MEMBER sign-in page — a form that
    // cannot authenticate a contact at all, on a plane they have no
    // account in, asking a client for credentials that would only ever
    // match one of the agency's own staff.
    url.pathname = pathname.startsWith(OPS_PREFIX)
      ? "/ops/login"
      : pathname.startsWith(PORTAL_PREFIX)
        ? PORTAL_LOGIN
        : "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return pass();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|ico)).*)"],
};
