import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { DomainError } from "@/lib/domain-error";

/**
 * Download responses (SECURITY.md §5): always `Content-Disposition:
 * attachment`, never cached — a CSV of time entries is tenant data and
 * the PWA shell caches nothing tenant-scoped (ARC-25); the browser must
 * not keep it either.
 */

/** RFC 6266 attachment disposition with an ASCII fallback + UTF-8 name. */
export const attachmentDisposition = (filename: string): string => {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
};

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** A CSV body as a same-origin download. */
export function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": attachmentDisposition(filename),
      "X-Content-Type-Options": "nosniff",
      ...NO_STORE,
    },
  });
}

/**
 * A download is a same-origin act. The member cookie is SameSite=Lax, so a
 * third-party page could top-level-navigate a signed-in member to a
 * download URL: the browser would save their CSV to disk and the export
 * would be audited under their name (nothing is readable cross-origin,
 * but a forced download + a spurious audit row is still not ours to
 * allow). Fetch metadata names the initiator; refuse `cross-site` — our
 * own links are same-origin, and a browser without the header (none
 * current) is let through rather than locked out.
 */
export function crossSiteRefusal(request: Request): Response | null {
  return request.headers.get("sec-fetch-site") === "cross-site"
    ? new Response(null, { status: 403, headers: NO_STORE })
    : null;
}

/** 400 with a one-word reason — never the request echoed back. */
export const badRequest = (what: string): Response =>
  new Response(`invalid ${what}`, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE } });

/**
 * The failure side of a download route: MFA_REQUIRED → step-up and back
 * to this exact URL (the browser then downloads); a scoping denial → 404
 * and a permission denial → 403, both bodiless (the boundary is
 * indistinguishable from a missing resource, UI.md §7.3); a domain error
 * (bad range…) → 400; anything else is a real failure and propagates.
 */
export function downloadFailure(e: unknown, returnTo: string): Response {
  handleAuthzRedirect(e, returnTo);
  if (e instanceof AuthzError) return new Response(null, { status: e.reason === "NOT_FOUND" ? 404 : 403, headers: NO_STORE });
  if (e instanceof DomainError) return badRequest(e.code.toLowerCase());
  throw e;
}
