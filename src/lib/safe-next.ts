/**
 * WHERE A SIGN-IN MAY SEND SOMEBODY — one function, used by all three
 * sign-in surfaces, because a redirect target that came from a query
 * string is a redirect target an attacker wrote. Since slice 137 also the
 * step-up and enrol return path (`safeNextPath`, whose `//`-and-`/\`
 * denylist let a TAB through) and the file actions' `returnTo`.
 *
 * **WHY IT EXISTS.** `src/proxy.ts` bounces every cookie-less request to
 * its plane's sign-in page carrying `?next=<pathname>` — a path the
 * proxy wrote itself, which is the ordinary case and is fine. But the
 * form reads whatever is in the URL, and `/login?next=https://evil.example`
 * was a link that signed a member in and then navigated them to a site
 * of the attacker's choosing, with the credibility of having just come
 * from their own workspace. `router.push` follows an absolute URL. The
 * portal's new sign-in form was about to be a third copy of the same
 * logic, and a review asked for one implementation rather than three; it
 * turned out only one of the three had any check at all.
 *
 * **THE RULE IS AN ALLOWLIST, NOT A DENYLIST.** Everything that is not
 * plainly a same-origin absolute path is refused, so a shape nobody
 * thought of falls back rather than through:
 *
 *   • it must begin with exactly one `/` — `//evil.example/x` is
 *     protocol-relative and loads another origin;
 *   • no backslash anywhere — browsers normalise `\` to `/`, so
 *     `/\evil.example` is `//evil.example`;
 *   • no `..` segment — `/portal/../home` normalises OUT of the prefix a
 *     caller asked to be confined to, which makes the prefix check a lie
 *     rather than a guard;
 *   • no control characters or whitespace, which is how a value gets
 *     smuggled past a naive check;
 *   • and, when the caller passes one, it must sit inside `prefix` on a
 *     SEGMENT boundary — `/portalfoo` is not inside `/portal`, the same
 *     anchoring `src/proxy.ts` applies to its own prefixes.
 */
const CONTROL_OR_SPACE = /[\x00-\x20\x7f]/;

export function safeNext(
  requested: string | null | undefined,
  fallback: `/${string}`,
  prefix?: `/${string}`,
): string {
  const value = requested ?? "";
  if (value === "" || CONTROL_OR_SPACE.test(value)) return fallback;
  if (value.includes("\\")) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  // Segment-wise, so `/a..b` and `/..foo` are ordinary paths while
  // `/a/../b` is not.
  if (value.split(/[?#]/)[0]!.split("/").includes("..")) return fallback;
  if (prefix !== undefined) {
    const path = value.split(/[?#]/)[0]!;
    if (path !== prefix && !path.startsWith(`${prefix}/`)) return fallback;
  }
  return value;
}
