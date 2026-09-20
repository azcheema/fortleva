import { NextResponse, type NextRequest } from "next/server";

import { planeForHost, sessionCookieName } from "@/config";

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
 * bind the cookie NAME (better-call signs the value alone) and all
 * three instances share one BETTER_AUTH_SECRET, so any credential
 * surface reachable on the wrong host is a way to mint that plane's
 * cookies where the host's controls do not apply. The portal belongs
 * to the APP host — `planeForHost`: "os.naxdor.com serves tenant +
 * portal" — so the ops host must 404 it, exactly as it does /api/auth.
 */
const PORTAL_API_PREFIX = "/api/portal-auth";
/** The portal's own sign-in page: a contact with no session must be
 * able to reach it. Invite acceptance will need the same treatment and
 * is deliberately NOT pre-added — the route does not exist yet, and a
 * public path standing open for a page nobody wrote is a hole waiting
 * for a name. It lands with the invite flow. */
const PORTAL_LOGIN = "/portal/login";
// The PWA shell's manifest and worker (ARC-25) carry no tenant data and
// must be fetchable without a session; on the ops host they are swept
// under /ops/… by the platform branch and 404 there — un-installable.
// /api/jobs/run authenticates itself (JOBS_RUN_TOKEN header): a cron has
// no member cookie, so the presence gate must not redirect it to /login.
const PUBLIC_PATHS = new Set(["/login", "/signup", "/ops/login", PORTAL_LOGIN, "/api/health", "/api/jobs/run", "/manifest.webmanifest", "/sw.js"]);

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const host = request.headers.get("host") ?? "";
  const plane = planeForHost(host);

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
    return plane === "platform"
      ? NextResponse.rewrite(new URL("/404", request.url))
      : NextResponse.next();
  }

  // The PLATFORM auth API is host-scoped exactly like the console it
  // serves. Checked BEFORE the platform branch below, so the ops host
  // does not sweep it under /ops and 404 its own sign-in.
  if (pathname.startsWith(PLATFORM_API_PREFIX)) {
    return plane === "platform"
      ? NextResponse.next()
      : NextResponse.rewrite(new URL("/404", request.url));
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
    return NextResponse.rewrite(new URL("/404", request.url));
  }

  if (PUBLIC_PATHS.has(pathname) || pathname.startsWith("/invite/")) return NextResponse.next();

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

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|ico)).*)"],
};
