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
const PORTAL_PREFIX = "/portal";
// The PWA shell's manifest and worker (ARC-25) carry no tenant data and
// must be fetchable without a session; on the ops host they are swept
// under /ops/… by the platform branch and 404 there — un-installable.
const PUBLIC_PATHS = new Set(["/login", "/signup", "/ops/login", "/api/health", "/manifest.webmanifest", "/sw.js"]);

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const host = request.headers.get("host") ?? "";
  const plane = planeForHost(host);

  // Auth endpoints pass through untouched on both hosts. The dev-only
  // storage stand-in is authorized by its own signed URL, like R2.
  if (pathname.startsWith("/api/auth") || pathname.startsWith("/api/dev-storage")) {
    return NextResponse.next();
  }

  if (plane === "platform") {
    // The ops host serves ONLY the platform console.
    if (!pathname.startsWith(OPS_PREFIX)) {
      const url = request.nextUrl.clone();
      url.pathname = `${OPS_PREFIX}${pathname === "/" ? "" : pathname}`;
      return NextResponse.redirect(url);
    }
  } else if (pathname.startsWith(OPS_PREFIX) && !PUBLIC_PATHS.has(pathname)) {
    // The app host never serves the console (separate host by decision 9).
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
    url.pathname = pathname.startsWith(OPS_PREFIX) ? "/ops/login" : "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|ico)).*)"],
};
