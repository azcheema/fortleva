import { getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";

import { fail, type DomainErrorCode } from "@/lib/domain-error";
import { commentExtensions, descriptionExtensions } from "./extensions";

/**
 * The rich-text gatekeeper: the browser sends JSON, and NOTHING it
 * sends is trusted. The document is parsed against the same schema the
 * editor uses (unknown node and mark types are refused there), then
 * rebuilt attribute by attribute from an allow-list, then parsed again —
 * so what is stored is what this file decided to store.
 *
 * Why the attribute pass exists: `Node.fromJSON().toJSON()` drops
 * attributes the schema does not declare, but keeps a DECLARED one
 * whatever its value. That is enough to store a `class` that restyles a
 * page, a `title` holding text a client can read but the team cannot see,
 * a `checked` string that makes the checklist count wrong, or a
 * `javascript:` href that the static renderer would print verbatim.
 *
 * It runs in Node with no DOM: the server actions, the dbtests and the
 * unit tests all use it, and the text and counts the database stores are
 * derived HERE — never sent by the client.
 *
 * TWO DOCUMENTS, ONE GATE (panel slice 10). A description and a comment
 * are different schemas with different caps (`extensions.ts`), and each
 * has its own entry point below; the walk between them is the same
 * code, so a hole closed for one cannot stay open in the other. A
 * comment must SAY something (an empty description is a legitimate
 * nothing-yet; an empty comment is a mis-click), and its caps are a
 * quarter of a description's — a reply is not a document.
 */

/** The JSON cap sits under Next's 1 MB server-action body limit. */
export const DESCRIPTION_JSON_BYTES = 512 * 1024;
/** `search_index` tokenises `left(body_text, 100000)`; beyond it a description would be silently half-indexed. */
export const DESCRIPTION_TEXT_CHARS = 100_000;
/** A comment's caps — a reply, not a document; still far past any honest use. */
export const COMMENT_JSON_BYTES = 128 * 1024;
export const COMMENT_TEXT_CHARS = 20_000;

/**
 * Built on first use, not on import. Constructing a schema walks every
 * extension; a module-scope call makes merely REACHING this file cost
 * that, which is exactly what a tree-shaker cannot remove.
 */
let descriptionSchema: ReturnType<typeof getSchema> | null = null;
let commentSchema: ReturnType<typeof getSchema> | null = null;
const schemaFor = (kind: RichTextKind): ReturnType<typeof getSchema> =>
  kind === "description"
    ? (descriptionSchema ??= getSchema(descriptionExtensions()))
    : (commentSchema ??= getSchema(commentExtensions()));

type JsonNode = {
  type?: unknown;
  content?: unknown;
  marks?: unknown;
  attrs?: unknown;
  text?: unknown;
};

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);
/**
 * U+0000 and unpaired surrogates. Postgres stores neither in `text` nor
 * in `jsonb` — it raises, and the raise would surface as a 500 from the
 * driver rather than as a refusal the panel can toast. Cheaper to find
 * here, where the answer is a typed DomainError.
 */
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LANGUAGE = /^[a-z0-9+#-]{0,20}$/;
const LIST_TYPES = new Set(["a", "A", "i", "I", "1"]);

/** http(s) and mailto only — `javascript:`, `data:` and a relative href are dropped with the mark. */
function safeHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!LINK_SCHEMES.has(url.protocol)) return null;
  // `https://www.the-bank.example@evil.test/` is a link to evil.test that
  // a person reads as their bank. Nothing this product does needs
  // credentials in a URL, and a description can be CLIENT_VISIBLE — so
  // the spoof would be aimed at the tenant's own customer.
  if (url.username !== "" || url.password !== "") return null;
  return url.href;
}

const int = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/** Every attribute this product stores, by node type. Anything else is dropped. */
const NODE_ATTRS: Record<string, (attrs: Record<string, unknown>) => Record<string, unknown>> = {
  heading: (a) => ({ level: int(a["level"], 1, 3, 1) }),
  codeBlock: (a) => ({
    language: typeof a["language"] === "string" && LANGUAGE.test(a["language"]) ? a["language"] : null,
  }),
  orderedList: (a) => ({
    start: int(a["start"], 1, 10_000, 1),
    type: typeof a["type"] === "string" && LIST_TYPES.has(a["type"]) ? a["type"] : null,
  }),
  // A STRING "false" is truthy in JavaScript and would have counted as done.
  taskItem: (a) => ({ checked: a["checked"] === true }),
};

/** Mark attributes. A mark whose builder returns null is dropped; its text stays. */
const MARK_ATTRS: Record<string, (attrs: Record<string, unknown>) => Record<string, unknown> | null> = {
  // href only: `target`, `rel`, `class` and `title` are render decisions,
  // not stored ones — a stored `class` restyles the page for everyone who
  // opens the task, and a stored `title` hides text in a tooltip.
  link: (a) => {
    const href = safeHref(a["href"]);
    return href === null ? null : { href };
  },
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

function sanitize(node: JsonNode): JsonNode {
  const type = String(node.type ?? "");
  const out: JsonNode = { type };
  if (typeof node.text === "string") out.text = node.text;

  const attrs = NODE_ATTRS[type]?.(asRecord(node.attrs));
  if (attrs && Object.keys(attrs).length > 0) out.attrs = attrs;

  if (Array.isArray(node.marks)) {
    const marks = node.marks
      .map((raw) => {
        const mark = raw as JsonNode;
        const markType = String(mark.type ?? "");
        if (!(markType in MARK_ATTRS)) return { type: markType }; // bold, italic, strike, code, underline
        const kept = MARK_ATTRS[markType]!(asRecord(mark.attrs));
        return kept === null ? null : { type: markType, attrs: kept };
      })
      .filter((m): m is { type: string; attrs?: Record<string, unknown> } => m !== null);
    if (marks.length > 0) out.marks = marks;
  }

  if (Array.isArray(node.content)) out.content = node.content.map((child) => sanitize(child as JsonNode));
  return out;
}

type RichTextKind = "description" | "comment";

type Caps = {
  readonly jsonBytes: number;
  readonly textChars: number;
  /** The code a document past either cap fails with — named per kind, so the toast names the right thing. */
  readonly tooLarge: DomainErrorCode;
};

const CAPS: Record<RichTextKind, Caps> = {
  description: { jsonBytes: DESCRIPTION_JSON_BYTES, textChars: DESCRIPTION_TEXT_CHARS, tooLarge: "DESCRIPTION_TOO_LARGE" },
  comment: { jsonBytes: COMMENT_JSON_BYTES, textChars: COMMENT_TEXT_CHARS, tooLarge: "COMMENT_TOO_LARGE" },
};

type Normalized = {
  /** Canonical JSON to store — or null when the document says nothing. */
  readonly doc: JsonNode | null;
  /** Plain text for the search feed and previews; null when empty. */
  readonly text: string | null;
  readonly checklistTotal: number;
  readonly checklistDone: number;
};

/**
 * Parse → allow-list → parse again → derive. Throws a DomainError for
 * anything the editor could not have produced (INVALID_INPUT) or for a
 * document past a cap (the kind's own TOO_LARGE code).
 */
function normalizeRichText(input: unknown, kind: RichTextKind): Normalized {
  const caps = CAPS[kind];
  const schema = schemaFor(kind);
  // Guarded: the input is whatever crossed a server-action boundary, and
  // React's decoder admits values `JSON.stringify` refuses — a BigInt
  // (`$n`) throws a TypeError here. Unguarded that leaves the gatekeeper
  // by a path `runAction` does not map, so a crafted body answers with an
  // untyped 500 instead of the INVALID_INPUT this file promises.
  let serialized: string;
  try {
    serialized = JSON.stringify(input ?? null);
  } catch {
    fail("INVALID_INPUT", `${kind} is not a document this editor can produce`);
  }
  if (Buffer.byteLength(serialized!, "utf8") > caps.jsonBytes) {
    fail(caps.tooLarge);
  }

  let parsed: PMNode;
  try {
    parsed = PMNode.fromJSON(schema, input as never);
  } catch {
    fail("INVALID_INPUT", `${kind} is not a document this editor can produce`);
  }
  // `fromJSON` builds whatever node type it is told to. A root that is
  // not `doc` — a bare paragraph, a lone text node — parses happily and
  // would be stored as the document, where every reader (and the
  // editor's own setContent on the next poll) expects a document.
  if (parsed!.type.name !== "doc") fail("INVALID_INPUT", `${kind} root is not a document`);

  let node: PMNode;
  try {
    // The second parse is the point: it proves the allow-listed result is
    // itself a valid document, rather than trusting the rewrite.
    node = PMNode.fromJSON(schema, sanitize(parsed!.toJSON() as JsonNode) as never);
    // …and `check()` is what makes the parse mean something. `fromJSON`
    // does NOT validate a node against its content expression, so a LEAF
    // can be handed children: `{type:"horizontalRule",content:[…text…]}`
    // survives both parses, renders nothing, and still reaches the
    // extracted text — which is the search index's body tier. That is
    // a task surfacing for words nobody can see on it. `check()` recurses
    // over content, attributes and marks; without it the two parses only
    // prove the node TYPES were known.
    node.check();
  } catch {
    fail("INVALID_INPUT", `${kind} did not survive normalisation`);
  }

  const text = node!.textBetween(0, node!.content.size, "\n", " ").trim();
  if (text.length > caps.textChars) fail(caps.tooLarge);
  if (UNSTORABLE.test(text)) fail("INVALID_INPUT", `${kind} contains characters the database cannot store`);

  let checklistTotal = 0;
  let checklistDone = 0;
  node!.descendants((child) => {
    if (child.type.name === "taskItem") {
      checklistTotal += 1;
      if (child.attrs["checked"] === true) checklistDone += 1;
    }
    return true; // nested checklists count too
  });

  const empty = text.length === 0 && checklistTotal === 0;
  const out = node!.toJSON() as JsonNode;
  // The cap above measured what ARRIVED; this measures what is STORED.
  // Normalisation adds attributes the sender omitted — every taskItem
  // gains `checked`, every heading a `level`, every codeBlock a
  // `language` — so a document that fitted on the way in can be half as
  // big again on the way out, and the column would take it.
  if (!empty && Buffer.byteLength(JSON.stringify(out), "utf8") > caps.jsonBytes) {
    fail(caps.tooLarge);
  }
  return {
    doc: empty ? null : out,
    text: empty ? null : text,
    checklistTotal,
    checklistDone,
  };
}

export type NormalizedDescription = Normalized;

/** The description: may be empty (stored as null), carries checklist counters. */
export function normalizeDescription(input: unknown): NormalizedDescription {
  return normalizeRichText(input, "description");
}

export type NormalizedComment = {
  /** Canonical JSON to store — never null: an empty comment is refused. */
  readonly doc: JsonNode;
  /** Plain text for `bodyText` (the search feed, previews) — never empty. */
  readonly text: string;
};

/**
 * The comment: the comment schema (no headings, no checklist), the
 * comment caps, and it must say something — a document whose text is
 * empty is COMMENT_EMPTY, never a stored blank.
 */
export function normalizeComment(input: unknown): NormalizedComment {
  const n = normalizeRichText(input, "comment");
  if (n.doc === null || n.text === null) fail("COMMENT_EMPTY");
  return { doc: n.doc!, text: n.text! };
}
