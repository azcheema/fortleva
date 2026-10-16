/**
 * The @mention node's type name (slice 125) — in a module of its own with
 * NO imports, because the static renderer reads it and the renderer runs in
 * client islands (`comment-card.tsx`) that must not pull Tiptap in through
 * `extensions.ts`. The schema, the normaliser, the renderer and the
 * database's guard (the CHECK `comment_visible_no_mention`) all match on this string.
 */
export const MENTION_NODE = "mention";

/** A member id as the database writes them (UUID, lower case) — the one thing a mention stores. */
export const MEMBER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
