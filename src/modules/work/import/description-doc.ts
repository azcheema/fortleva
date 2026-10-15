/**
 * AN IMPORTED ROW'S TEXT → A TASK DESCRIPTION (Phase 6 slice 121; design
 * §2.4). Runs on the SERVER from the row's plain values — the browser never
 * sends a document — and its output always goes through
 * `normalizeDescription`, the one gate every description passes, which is
 * what decides what is stored (unsafe links are dropped there).
 *
 * Deliberately small. What spreadsheets and Trello cards actually contain is
 * paragraphs, bullet and numbered lists, `- [ ]` checklist lines, `#`
 * headings and links; those become their nodes. Everything else stays as
 * typed — `**bold**` keeps its asterisks — because a half-implemented
 * Markdown is worse than plain text: it would mangle the cases it guessed
 * wrong, silently.
 */

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string; marks?: Json[] };

// Each tail is `\s+(\S.*)$`, never `\s+(.+)$`: in the second, a space
// matches both groups, so a line whose `$` fails makes V8 try every split
// of a run of spaces — quadratic, on text the browser chose, before any
// gate (the fix round's re-check; the AGENTS.md trap). Here the spaces can
// only ever belong to `\s+`.
const HEADING = /^(#{1,3})\s+(\S.*)$/;
const CHECK_ITEM = /^\s*[-*]\s+\[([ xX])\]\s+(\S.*)$/;
const BULLET = /^\s*[-*•]\s+(\S.*)$/;
const ORDERED = /^\s*(\d{1,4})[.)]\s+(\S.*)$/;
/**
 * U+2028 and U+2029, the LINE and PARAGRAPH separators: line breaks too —
 * and the two characters `.` does not match, so one left inside a line was
 * what made a pattern's `$` fail. Built from their codes so no tool can
 * turn an escape into the invisible character itself.
 */
const LINE_SEPARATORS = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
/** `[text](https://…)` — the one inline Markdown form kept, because it carries a link. */
const MD_LINK = /\[([^\]\n]{1,500})\]\((https?:\/\/[^\s)]{1,2000})\)/g;
const URL = /https?:\/\/[^\s<>"'\]]{1,2000}/g;
/** Punctuation that ends a sentence, not a URL ("see https://x.se/a." → the link is …/a). */
const URL_TAIL_CHARS = new Set([".", ",", ";", ":", "!", "?", ")"]);
/**
 * The URL without its sentence punctuation — a backwards walk, NEVER
 * `/[.,;:!?)]+$/`: an unanchored `+$` is quadratic in V8 on a long run that
 * does not end the string (the security review's MEDIUM, the shape of
 * CVE-2021-3765), and this runs on the server, on text the browser chose.
 */
const withoutTail = (url: string): string => {
  let end = url.length;
  while (end > 0 && URL_TAIL_CHARS.has(url[end - 1]!)) end--;
  return url.slice(0, end);
};

const text = (value: string, href?: string): Json =>
  href ? { type: "text", text: value, marks: [{ type: "link", attrs: { href } }] } : { type: "text", text: value };

/** One line's inline content: plain runs, Markdown links and bare URLs as link marks. Never an empty text node. */
export function inline(line: string): Json[] {
  const out: Json[] = [];
  const push = (value: string, href?: string) => {
    if (value !== "") out.push(text(value, href));
  };
  const bare = (segment: string) => {
    let last = 0;
    for (const m of segment.matchAll(URL)) {
      const raw = m[0];
      const url = withoutTail(raw);
      const at = m.index!;
      push(segment.slice(last, at));
      push(url, url);
      last = at + url.length;
    }
    push(segment.slice(last));
  };
  let last = 0;
  for (const m of line.matchAll(MD_LINK)) {
    bare(line.slice(last, m.index!));
    push(m[1]!, m[2]!);
    last = m.index! + m[0].length;
  }
  bare(line.slice(last));
  return out;
}

const paragraph = (lines: readonly string[]): Json => {
  const content: Json[] = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: "hardBreak" });
    content.push(...inline(line));
  });
  return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
};

const item = (type: "listItem" | "taskItem", line: string, checked?: boolean): Json => ({
  type,
  ...(type === "taskItem" ? { attrs: { checked: checked === true } } : {}),
  content: [paragraph([line])],
});

/** Plain text → block nodes (paragraphs, headings, the three lists). */
export function textBlocks(source: string): Json[] {
  const blocks: Json[] = [];
  let para: string[] = [];
  let list: Json | null = null;
  const flushPara = () => {
    if (para.length > 0) blocks.push(paragraph(para));
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  const into = (type: "bulletList" | "orderedList" | "taskList", node: Json, start?: number) => {
    flushPara();
    if (!list || list.type !== type) {
      flushList();
      list = { type, ...(type === "orderedList" ? { attrs: { start: start ?? 1 } } : {}), content: [] };
    }
    list.content!.push(node);
  };
  let unified = source.replace(/\r\n?/g, "\n");
  for (const sep of LINE_SEPARATORS) unified = unified.split(sep).join("\n");
  for (const raw of unified.split("\n")) {
    // `trimEnd`, never `replace(/\s+$/, …)`: the regex is quadratic on a
    // long run of spaces that does not end the line, and a 40 000-character
    // line of them would hold the server for seconds (the security review).
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    let m = HEADING.exec(line);
    if (m) {
      flushPara();
      flushList();
      blocks.push({ type: "heading", attrs: { level: m[1]!.length }, content: inline(m[2]!.trim()) });
      continue;
    }
    m = CHECK_ITEM.exec(line);
    if (m) {
      into("taskList", item("taskItem", m[2]!.trim(), m[1] !== " "));
      continue;
    }
    m = BULLET.exec(line);
    if (m) {
      into("bulletList", item("listItem", m[1]!.trim()));
      continue;
    }
    m = ORDERED.exec(line);
    if (m) {
      into("orderedList", item("listItem", m[2]!.trim()), Number(m[1]));
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  // No empty text node can reach a block: each line had its trailing space
  // removed above, so every heading and list pattern's `.+` holds a
  // non-space character, and `inline` drops empty runs.
  return blocks;
}

/**
 * The whole description: the row's text, then each checklist (a level-3
 * heading with its name, when it has one, and a task list), then the
 * closing link line. `null` when there is nothing at all — the column then
 * stays NULL, as a task created by hand starts.
 */
export function importDescription(input: {
  text: string;
  checklists: readonly { name: string | null; items: readonly { text: string; done: boolean }[] }[];
  link: string | null;
  /** "Imported from Trello:" in the importer's language. */
  linkLabel: string;
}): Json | null {
  const content: Json[] = textBlocks(input.text);
  for (const c of input.checklists) {
    const items = c.items.filter((i) => i.text.trim() !== "");
    if (items.length === 0) continue;
    if (c.name) content.push({ type: "heading", attrs: { level: 3 }, content: inline(c.name) });
    content.push({ type: "taskList", content: items.map((i) => item("taskItem", i.text.trim(), i.done)) });
  }
  if (input.link) {
    content.push({ type: "paragraph", content: [text(`${input.linkLabel} `), text(input.link, input.link)] });
  }
  return content.length > 0 ? { type: "doc", content } : null;
}
