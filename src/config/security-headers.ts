/**
 * Headers every response of the app carries (`next.config.ts` → `headers()`).
 *
 * **NO PAGE OF THE APP MAY BE FRAMED** (slice 85's security review). The
 * member cookie is SameSite=Lax, so it travels into a frame embedded by
 * any page on the same SITE — a sibling subdomain, the marketing site —
 * and a framed vault would make its own same-origin fetches: the reveal
 * edge's `Sec-Fetch-Site` check (`src/app/api/vault/respond.ts`) never
 * sees the embedder. An invisible frame under a decoy button is then a
 * click on Copy, with the clipboard write granted by the embedder's
 * `allow="clipboard-write"`. Nothing in the product frames itself, so the
 * answer is the strict one, for every path: `frame-ancestors 'none'`,
 * and `X-Frame-Options: DENY` for any browser that predates it.
 *
 * Only `frame-ancestors`: this is not the script CSP SECURITY.md §3.6 once
 * called "strict" — that does not exist yet, and this header does not
 * pretend to be it.
 */
export const SECURITY_HEADERS: readonly { readonly key: string; readonly value: string }[] = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
];
