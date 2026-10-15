/**
 * A short one-line name as it will be stored — a stage's or a label's
 * (slice 123): any run of whitespace (a pasted newline, a tab) becomes one
 * space and the ends are trimmed; blank is refused; past `max` code points
 * is refused; any control character left (C0, DEL, C1) or invisible
 * formatting character (bidi, zero-width) is refused rather than stripped. Checked by code point, so no escape sequence in this file
 * can be mangled by a tool on its way to disk.
 *
 * Pure, RSC-safe, no directive — the services decide with it and the zod
 * shapes in the actions call it first.
 */
export function singleLineName(
  raw: string,
  max: number,
): { ok: true; name: string } | { ok: false; code: "NAME_REQUIRED" | "INVALID_INPUT" } {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name === "") return { ok: false, code: "NAME_REQUIRED" };
  const points = [...name];
  if (points.length > max) return { ok: false, code: "INVALID_INPUT" };
  if (points.some((ch) => isControl(ch.codePointAt(0)!) || isInvisible(ch.codePointAt(0)!))) {
    return { ok: false, code: "INVALID_INPUT" };
  }
  return { ok: true, name };
}

const isControl = (c: number): boolean => c < 32 || (c >= 127 && c < 160);

/**
 * Characters that change how a name LOOKS without being seen — the bidi
 * marks, embeddings, overrides and isolates, the zero-width ones and the
 * byte-order mark — refused so a name cannot be spoofed or a duplicate
 * faked by one nobody can see (the security review's NIT; the import's
 * label path already strips the bidi range).
 */
export const isInvisible = (c: number): boolean =>
  // The zero-width JOINER (U+200D) is deliberately allowed: it is what
  // holds multi-part emoji together (a person and a laptop as one), and a
  // label or stage named with one is ordinary. On its own it is a weak
  // spoofing tool, and refusing it would refuse real names (the fix
  // review's NIT — a decision, recorded).
  c === 0x200b || // zero-width space
  c === 0x200c || // zero-width non-joiner
  c === 0x200e || // left-to-right mark
  c === 0x200f || // right-to-left mark
  (c >= 0x202a && c <= 0x202e) || // embeddings and overrides
  (c >= 0x2060 && c <= 0x2064) || // word joiner and the invisible operators
  (c >= 0x2066 && c <= 0x2069) || // isolates
  c === 0x061c || // Arabic letter mark
  c === 0xfeff; // byte-order mark / zero-width no-break space
