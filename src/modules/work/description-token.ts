import { createHash } from "node:crypto";

/**
 * Its own module for ONE reason: what imports it. `items.ts` needs this
 * hash to hand the panel a base token, and `items.ts` is imported by
 * every list surface there is — the board, the backlog, search, the
 * inbox, the home page. While this lived beside the write path it
 * dragged `normalize.ts` in with it, and `normalize.ts` builds a
 * ProseMirror schema from the Tiptap extension set at module scope: the
 * whole editor graph, `prosemirror-view` included, in the server bundle
 * of routes that never render a description. A sha256 of some JSON needs
 * none of that.
 */

/**
 * What an editor holds so it can tell "nothing moved" from "someone else
 * saved". NOT `updatedAt`: a rank move bumps that, and the panel would
 * refuse a save because a colleague dragged the card.
 *
 * ONLY EVER HASH A DOCUMENT THAT HAS BEEN THROUGH POSTGRES. jsonb does
 * not store the bytes it was given: it re-orders every object's keys
 * canonically, so the `{"type":"text","text":"hi"}` this process sends
 * comes back `{"text":"hi","type":"text"}` — jsonb-EQUAL, a different
 * string, and therefore a different hash. Hashing the document on its
 * way IN produces a token no later read can reproduce: the first save of
 * an editing session succeeds and every one after it is refused as
 * stale. That is why the write returns its row instead of a row count
 * (`description.dbtest.ts` fails on all six paths without it).
 *
 * It is only the FAST check either way: the write itself compares the
 * document in SQL, where the comparison is jsonb-to-jsonb and key order
 * cannot matter.
 */
export const descriptionToken = (doc: unknown): string =>
  createHash("sha256")
    .update(doc === null || doc === undefined ? "" : JSON.stringify(doc))
    .digest("hex")
    .slice(0, 32);
