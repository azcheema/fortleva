import type { CSSProperties } from "react";

/**
 * Deterministic entity colour (DESIGN SPEC §2.6).
 *
 * Twelve frozen hues, each anchored to 3:1 against every surface of its
 * theme, exposed as --entity-0 … --entity-11 in globals.css. A client
 * or project always gets the same dot, on every screen, for every
 * member, for ever — which is the whole point: it is IDENTITY, never
 * status. The label next to it always carries the meaning.
 *
 * Pure and RSC-safe: no Math.random, no Date, no DOM. Same input, same
 * output, on the server and in the browser.
 */

export const ENTITY_HUES = [15, 45, 75, 105, 140, 168, 196, 225, 255, 285, 315, 345] as const;
export const ENTITY_COUNT = ENTITY_HUES.length;

/** FNV-1a, 32-bit. Cheap, well-distributed over short cuid/uuid keys. */
export function entityHash(key: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % ENTITY_COUNT;
}

/**
 * Always pass the IMMUTABLE id. `name` is a last-resort fallback for
 * optimistic rows that do not have an id yet; it is reconciled the
 * moment the server response arrives, so a row must never keep a
 * name-derived colour after it is persisted (renaming a client would
 * otherwise silently change its identity dot).
 */
export function entityIndex(id: string | null | undefined, name: string): number {
  return entityHash(id ?? name);
}

/** The custom property to read: `style={entityStyle(id, name)}` + `bg-(--entity)`. */
export function entityStyle(id: string | null | undefined, name: string): CSSProperties {
  return { "--entity": `var(--entity-${entityIndex(id, name)})` } as CSSProperties;
}

/** Up to two initials, upper-cased, from a display name. */
export function entityInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]!}${parts[parts.length - 1]![0]!}`.toUpperCase();
}
