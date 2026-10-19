/**
 * A REFUSAL CARRIED BACK IN `?error=` IS A CODE, NEVER A SENTENCE (slice 137;
 * slice 130's security LOW-1). A form-POST action that cannot answer with a
 * toast — a file's download, its delete or sign-off ask from a row menu, an
 * export's download — redirects back to the page it came from with the
 * refusal in the address. That address is a link anyone can write and send:
 * while it carried the sentence itself, the page drew whatever text the link
 * held in a danger callout, in the product's own voice. Now it carries the KEY
 * of one of our own messages, and the page looks it up (`bounceMessage`);
 * anything else draws nothing.
 *
 * Two catalogues: `files.<key>` is `files.errors.*` (the file actions' own
 * wording), `domain.<KEY>` is `domainErrors.*` (the member plane's one mapping
 * for a DomainError and an AuthzError's reason). The pure half lives here, with
 * no imports, so a unit test can reach it; the redirect and the lookup are in
 * `bounce.ts`.
 */

export type BounceCode = `files.${string}` | `domain.${string}`;

export type ParsedBounce = { readonly catalogue: "files" | "domain"; readonly key: string };

// Anchored and bounded: the value is the caller's to write.
const FILES_KEY = /^[a-z][A-Za-z]{0,63}$/;
const DOMAIN_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

/** `?error=` as the page received it — a repeated parameter is no code. */
export function parseBounce(raw: unknown): ParsedBounce | null {
  if (typeof raw !== "string") return null;
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const head = raw.slice(0, dot);
  const key = raw.slice(dot + 1);
  if (head === "files" && FILES_KEY.test(key)) return { catalogue: "files", key };
  if (head === "domain" && DOMAIN_KEY.test(key)) return { catalogue: "domain", key };
  return null;
}

/**
 * Whether `key` is one of the catalogue's OWN strings. Not next-intl's `t.has`:
 * it walks `messages[part]`, so `constructor` or `toString` — inherited, never
 * ours — would pass it.
 */
export function isOwnMessage(catalogue: unknown, key: string): boolean {
  return (
    typeof catalogue === "object" &&
    catalogue !== null &&
    Object.hasOwn(catalogue, key) &&
    typeof (catalogue as Record<string, unknown>)[key] === "string"
  );
}

/** `path` with the code added as `error=`, after any query it already has. */
export const withBounce = (path: string, code: BounceCode): string =>
  `${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(code)}`;
