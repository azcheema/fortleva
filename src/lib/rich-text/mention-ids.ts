import { MENTION_NODE } from "./mention-node";

/**
 * The member ids a STORED comment body mentions (slice 125) — distinct, in
 * order of first appearance. For bodies that have been through
 * `normalizeComment` (the only way a comment is written), so it only reads:
 * an odd shape yields nothing rather than throwing. The panel's read uses
 * it to resolve the names it renders and to know whether a note may be
 * shown to the client (`hasMention`); the writers use `normalizeComment`'s
 * own list, never this.
 */
export function mentionIdsIn(doc: unknown): string[] {
  const out = new Set<string>();
  const walk = (raw: unknown): void => {
    if (typeof raw !== "object" || raw === null) return;
    const node = raw as { type?: unknown; attrs?: unknown; content?: unknown };
    if (node.type === MENTION_NODE && typeof node.attrs === "object" && node.attrs !== null) {
      const id = (node.attrs as { id?: unknown }).id;
      if (typeof id === "string") out.add(id);
    }
    if (Array.isArray(node.content)) for (const child of node.content) walk(child);
  };
  walk(doc);
  return [...out];
}
