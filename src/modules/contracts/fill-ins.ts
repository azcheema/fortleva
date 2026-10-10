/**
 * THE FILL-INS (Phase 4 slice 112, founder decision C84 (e)) — a LEAF with
 * no imports, read by the template editor's "Insert fill-in" menu in the
 * browser and by `startContract` on the server, so both use one list.
 *
 * A template carries `{{key}}` tokens from the fixed list below. Starting a
 * contract replaces each token whose value is known, ONCE; nothing re-fills
 * later, because C84 (e) lets the person edit any of the text afterwards,
 * and a re-fill would undo their edit. A token whose value is missing (a
 * client with no org number on its card) stays in the text, and slice 112b's
 * send refuses while any of the list remains. A `{{…}}` that is not on the
 * list is ordinary text.
 *
 * A token is matched WITHIN ONE TEXT NODE only (the design, §2.2): the menu
 * inserts it unformatted, and a token half bold is no longer one token to a
 * reader either.
 */

export const FILL_IN_KEYS = [
  "client_name",
  "client_org_nr",
  "client_address",
  "signer_name",
  "agency_name",
  "agency_org_nr",
  "agency_address",
  "today",
] as const;

export type FillInKey = (typeof FILL_IN_KEYS)[number];

/** What each key is filled with, or null when the value is missing. */
export type FillInValues = Readonly<Record<FillInKey, string | null>>;

const KEY_SET: ReadonlySet<string> = new Set(FILL_IN_KEYS);

/** The token as written in a template. */
export const fillInToken = (key: FillInKey): string => `{{${key}}}`;

const TOKEN = /\{\{([a-z_]+)\}\}/g;

type DocNode = {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly content?: unknown;
  readonly [k: string]: unknown;
};

/**
 * The document with every known token replaced by its value. Marks and
 * attributes are kept (a token in a bold run gives a bold value); a value
 * is plain text. A text node a replacement would leave EMPTY cannot exist
 * in ProseMirror — a value is never empty (`values` says null instead), so
 * that cannot happen, and an empty string is treated as missing anyway.
 */
export function fillIn<T>(doc: T, values: FillInValues): T {
  const walk = (node: DocNode): DocNode => {
    if (typeof node.text === "string") {
      const text = node.text.replace(TOKEN, (whole, key: string) => {
        if (!KEY_SET.has(key)) return whole;
        const value = values[key as FillInKey];
        return value === null || value === "" ? whole : value;
      });
      return text === node.text ? node : { ...node, text };
    }
    if (Array.isArray(node.content)) {
      return { ...node, content: (node.content as DocNode[]).map(walk) };
    }
    return node;
  };
  if (doc === null || typeof doc !== "object") return doc;
  return walk(doc as DocNode) as T;
}

const keysIn = (text: string, into: Set<string>): void => {
  for (const m of text.matchAll(TOKEN)) {
    if (KEY_SET.has(m[1]!)) into.add(m[1]!);
  }
};

/**
 * Each known key found WHOLE in one text node, and each found only in a
 * textblock's joined text — a token split by formatting (`{{client_` plain,
 * `name}}` bold), which `fillIn` never fills (the design review's item 14).
 */
function scan(doc: unknown): { whole: Set<string>; joined: Set<string> } {
  const whole = new Set<string>();
  const joined = new Set<string>();
  const walk = (node: DocNode): void => {
    const kids = Array.isArray(node.content) ? (node.content as DocNode[]) : [];
    if (typeof node.text === "string") keysIn(node.text, whole);
    // A textblock: its inline children read as one run of text.
    if (kids.some((k) => typeof k.text === "string")) {
      keysIn(kids.map((k) => (typeof k.text === "string" ? k.text : "")).join(""), joined);
    }
    for (const child of kids) walk(child);
  };
  if (doc !== null && typeof doc === "object") walk(doc as DocNode);
  return { whole, joined };
}

/**
 * The keys of the list still present in the document, in list order — a
 * token split by formatting included: it reads as a fill-in to a person and
 * was never filled, so it is still to fill in.
 */
export function remainingFillIns(doc: unknown): FillInKey[] {
  const { whole, joined } = scan(doc);
  return FILL_IN_KEYS.filter((k) => whole.has(k) || joined.has(k));
}

/**
 * The keys present ONLY split across formatting — what a template's save
 * warns of, since starting a contract from it will not fill them.
 */
export function splitFillIns(doc: unknown): FillInKey[] {
  const { whole, joined } = scan(doc);
  return FILL_IN_KEYS.filter((k) => joined.has(k) && !whole.has(k));
}

/** One line of an address: the non-empty parts, joined by ", ". */
export function addressLine(parts: readonly (string | null | undefined)[]): string | null {
  const kept = parts.map((p) => (p ?? "").trim()).filter((p) => p.length > 0);
  return kept.length === 0 ? null : kept.join(", ");
}
