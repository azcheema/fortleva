/**
 * WORD'S LISTS — THE PURE HALF (slice 132, founder decision C109). Word's
 * clipboard HTML draws a list as PARAGRAPHS, each styled
 * `mso-list:l<list> level<n> lfo<k>` and starting with the marker Word drew
 * ("·", "o", "§", "1.", "a.", "iv."). The browser half
 * (`paste-formatting.ts`) finds those paragraphs — only in Word's HTML, by
 * that style, so "§ 3 Betalning" or "J. Doe" typed anywhere else is never a
 * list (the code review's LOW-8) — reads each one's level, list and marker,
 * and asks this file which lists to build.
 *
 * The LEVEL is Word's own, never guessed from the marker: a lettered
 * sub-list's "c." is the third item of a lettered list, not a roman 100 a
 * level deeper (MEDIUM-3). A list's kind and start come from its FIRST item.
 */

export type WordItem = { readonly level: number; readonly list: string; readonly marker: string };

export type WordListKind =
  | { readonly ordered: false }
  | { readonly ordered: true; readonly type: "1" | "a" | "A" | "i" | "I"; readonly start: number };

export type WordList = {
  readonly kind: WordListKind;
  /** Each item: the run's paragraph index, and its nested lists. */
  readonly items: { readonly index: number; readonly children: WordList[] }[];
};

/** `mso-list:l0 level2 lfo1` — the list and the level; null for any other style. */
const WORD_LIST_STYLE = /mso-list:\s{0,4}(l\d{1,4})\s{1,4}level(\d{1,2})/i;

export function wordListOf(style: string): { list: string; level: number } | null {
  const m = WORD_LIST_STYLE.exec(style);
  if (!m) return null;
  const level = Number(m[2]);
  return level >= 1 && level <= 9 ? { list: m[1]!.toLowerCase(), level } : null;
}

const ROMAN: Readonly<Record<string, number>> = { i: 1, v: 5, x: 10, l: 50, c: 100 };

function romanValue(s: string): number | null {
  let total = 0;
  for (let k = 0; k < s.length; k++) {
    const v = ROMAN[s[k]!.toLowerCase()];
    const next = k + 1 < s.length ? ROMAN[s[k + 1]!.toLowerCase()] : undefined;
    if (v === undefined) return null;
    total += next !== undefined && next > v ? -v : v;
  }
  return total >= 1 ? total : null;
}

/** What a list's first marker makes it: numbered from n, lettered, roman, or bulleted. */
export function wordListKind(marker: string): WordListKind {
  const m = /^(\d{1,4}|[A-Za-z]{1,6})[.)]$/.exec(marker.trim());
  if (!m) return { ordered: false };
  const token = m[1]!;
  if (/^\d+$/.test(token)) return { ordered: true, type: "1", start: Math.max(1, Number(token)) };
  const lower = token.toLowerCase();
  const upper = token === token.toUpperCase();
  // A FIRST item "i." or "ii." is roman; any other single letter is a letter.
  if (/^[ivxlc]+$/.test(lower) && (lower.length > 1 || lower === "i")) {
    const value = romanValue(lower);
    if (value !== null) return { ordered: true, type: upper ? "I" : "i", start: value };
  }
  if (token.length === 1) return { ordered: true, type: upper ? "A" : "a", start: lower.charCodeAt(0) - 96 };
  return { ordered: true, type: upper ? "A" : "a", start: 1 };
}

/**
 * A run of Word's list paragraphs as nested lists. A deeper level opens a
 * list inside the item above; a shallower one closes back; a different
 * Word list at the same level starts a list of its own. A run that starts
 * deeper than it later goes is several lists — nothing is dropped; a
 * skipped level nests under the item above.
 */
export function wordListTree(items: readonly WordItem[]): WordList[] {
  let i = 0;
  const build = (level: number): WordList => {
    const first = items[i]!;
    const list: WordList = { kind: wordListKind(first.marker), items: [] };
    while (i < items.length && items[i]!.level >= level) {
      const it = items[i]!;
      if (it.level > level) {
        // Never the first: a list starts with an item at its own level.
        list.items[list.items.length - 1]!.children.push(build(it.level));
        continue;
      }
      if (it.list !== first.list && list.items.length > 0) break;
      list.items.push({ index: i, children: [] });
      i++;
    }
    return list;
  };
  const out: WordList[] = [];
  while (i < items.length) out.push(build(items[i]!.level));
  return out;
}
