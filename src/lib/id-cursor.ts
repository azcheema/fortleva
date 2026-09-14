/**
 * A keyset cursor that is a row id — the inbox's rule (2026-09-06) and
 * the item panel's Activity section's: a canonical UUID, or nothing.
 * Anything else — an empty param, a hand-made link, a stale token — is
 * the first page, never an error and never a 404.
 *
 * Lowercased on the way in: the id columns hold Prisma's lowercase hex
 * and the database compares TEXT byte-wise (`C.UTF-8`, asserted by
 * `isolation.dbtest.ts`), so an upper-case cursor would sort before
 * every stored id that shares its digits and page from the wrong point.
 * ONE parser for every id-keyed page, so the two surfaces cannot drift.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const idCursor = (raw: string | null | undefined): string | null =>
  raw && UUID_RE.test(raw) ? raw.toLowerCase() : null;
