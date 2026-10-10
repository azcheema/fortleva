// OUT OF THE REACT COMPILER: rendered by react-pdf's own reconciler, on the
// React that `@react-pdf/renderer` (a server-external package) loads — the
// invoice's PDF says why at length.
"use no memo";

import type { ReactNode } from "react";

import { Document, Link, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { createTranslator } from "next-intl";

import { registerPdfFonts } from "@/lib/pdf-fonts";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

import type { ContractLocale, ContractParty, ContractPrint } from "../print";

/**
 * A CONTRACT'S PDF (Phase 4 slice 112; founder decision C84 (a)) — a pure
 * drawing of a `ContractPrint`: the title and version, the two parties, the
 * body, and on every page a foot with the title, the version and the page.
 * A DRAFT's preview says so on every page; slice 112b draws the PDF as sent
 * and the signed copy (with its signature page) from the frozen record.
 *
 * THE BODY WALKER draws exactly the contract schema (`contractExtensions` in
 * `src/lib/rich-text/extensions.ts`): paragraphs, headings 1–3, bullet and
 * numbered lists (nested), blockquotes, rules and hard breaks; bold, italic,
 * underline, strike and links. The normaliser refuses every other node before
 * a body is stored, so an unknown one here is a schema change made without
 * this file — it is drawn as its text, never dropped, so nothing in a
 * contract can go missing from its PDF.
 */

/** A printed page has no theme: these are the PDF's own inks, not the app's tokens. */
const INK = { text: "#1a1a1a", muted: "#5f5f5f", rule: "#d4d4d4", draft: "#9a3412" } as const;

const s = StyleSheet.create({
  // NO line height on the page: the foot's page number (`render`) would
  // inherit it, and react-pdf 4.9 then lays that text out at -1e22 points
  // once a contract runs to some twenty pages ("unsupported number" —
  // measured 2026-10-10). The body carries it instead.
  page: { fontFamily: "Inter", fontSize: 10, color: INK.text, paddingTop: 44, paddingBottom: 72, paddingHorizontal: 54 },
  body: { lineHeight: 1.45 },
  draft: { position: "absolute", top: 18, left: 54, right: 54, fontSize: 8, fontWeight: 600, color: INK.draft, textAlign: "center", textTransform: "uppercase", letterSpacing: 0.6 },
  title: { fontSize: 18, lineHeight: 1.25, fontWeight: 600, marginBottom: 4 },
  version: { fontSize: 9, color: INK.muted, marginBottom: 18 },
  label: { fontSize: 7.5, color: INK.muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 },
  parties: { flexDirection: "row", justifyContent: "space-between", marginBottom: 22, paddingBottom: 14, borderBottomWidth: 0.5, borderBottomColor: INK.rule },
  party: { width: "47%" },
  strong: { fontWeight: 600 },
  p: { marginBottom: 7 },
  h1: { fontSize: 14, lineHeight: 1.3, fontWeight: 600, marginTop: 10, marginBottom: 6 },
  h2: { fontSize: 12, lineHeight: 1.3, fontWeight: 600, marginTop: 8, marginBottom: 5 },
  h3: { fontSize: 10.5, lineHeight: 1.35, fontWeight: 600, marginTop: 6, marginBottom: 4 },
  list: { marginBottom: 7 },
  item: { flexDirection: "row", marginBottom: 2 },
  marker: { width: 18 },
  itemBody: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  quote: { borderLeftWidth: 2, borderLeftColor: INK.rule, paddingLeft: 10, marginBottom: 7, color: INK.muted },
  rule: { borderBottomWidth: 0.5, borderBottomColor: INK.rule, marginVertical: 10 },
  link: { color: INK.text, textDecoration: "underline" },
  foot: { position: "absolute", bottom: 30, left: 54, right: 54, borderTopWidth: 0.5, borderTopColor: INK.rule, paddingTop: 6, fontSize: 7.5, color: INK.muted, flexDirection: "row", justifyContent: "space-between" },
});

/** One of this sheet's block styles. */
type BlockStyle = (typeof s)[keyof typeof s];

const MESSAGES = { en, sv } as const;

function translatorFor(locale: ContractLocale) {
  return createTranslator({ locale, messages: MESSAGES[locale], namespace: "contractPdf" });
}

type PmMark = { readonly type?: unknown; readonly attrs?: { readonly href?: unknown } };
type PmNode = {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly content?: unknown;
  readonly marks?: unknown;
  readonly attrs?: { readonly level?: unknown; readonly start?: unknown; readonly type?: unknown };
};

const children = (node: PmNode): PmNode[] => (Array.isArray(node.content) ? (node.content as PmNode[]) : []);

/** The plain text of a node — what an unknown node is drawn as. */
function plain(node: PmNode): string {
  if (typeof node.text === "string") return node.text;
  // Never a newline: see `paragraph`.
  return children(node).map(plain).join(" ");
}

/** One text node with its marks, as nested react-pdf text. */
function inline(node: PmNode, key: number): ReactNode {
  if (typeof node.text !== "string") return plain(node);
  const marks = Array.isArray(node.marks) ? (node.marks as PmMark[]) : [];
  const style: Record<string, string | number> = {};
  const decorations: string[] = [];
  let href: string | null = null;
  for (const m of marks) {
    if (m.type === "bold") style["fontWeight"] = 600;
    else if (m.type === "italic") style["fontStyle"] = "italic";
    else if (m.type === "underline") decorations.push("underline");
    else if (m.type === "strike") decorations.push("line-through");
    else if (m.type === "link" && typeof m.attrs?.href === "string") href = m.attrs.href;
  }
  if (decorations.length > 0) style["textDecoration"] = decorations.join(" ");
  if (href !== null) {
    return (
      <Link key={key} src={href} style={[s.link, style]}>
        {node.text}
      </Link>
    );
  }
  return (
    <Text key={key} style={style}>
      {node.text}
    </Text>
  );
}

/**
 * A paragraph, its hard breaks drawn as LINES of their own: react-pdf 4.9
 * lays out any newline character in react-pdf's default Helvetica, whatever
 * the family (measured 2026-10-10 — the glyph is never seen, but the PDF then
 * references a font that cannot print "Łódź"). So no newline is ever drawn: a
 * paragraph with breaks is a column of one Text per line, and an empty line
 * (the author's blank line, or two breaks in a row) keeps its height.
 */
function paragraph(node: PmNode, key: number, style: BlockStyle | undefined): ReactNode {
  const lines: PmNode[][] = [[]];
  for (const child of children(node)) {
    if (child.type === "hardBreak") lines.push([]);
    else lines[lines.length - 1]!.push(child);
  }
  const line = (parts: PmNode[], k: number, st?: BlockStyle) => (
    <Text key={k} style={st}>
      {parts.length === 0 ? " " : parts.map((part, i) => inline(part, i))}
    </Text>
  );
  if (lines.length === 1) return line(lines[0]!, key, style);
  return (
    <View key={key} style={style}>
      {lines.map((parts, i) => line(parts, i))}
    </View>
  );
}

const runs = (node: PmNode): ReactNode[] => children(node).map((child, i) => inline(child, i));

const ROMAN: readonly [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

/** An ordered list's marker as the editor shows it: 1, a, A, i or I (the normaliser's `type`). */
export function listMarker(n: number, type: string): string {
  if (type === "a" || type === "A") {
    let out = "";
    for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) out = String.fromCharCode(97 + ((k - 1) % 26)) + out;
    return type === "A" ? out.toUpperCase() : out;
  }
  if (type === "i" || type === "I") {
    let out = "";
    let k = n;
    for (const [v, r] of ROMAN) {
      while (k >= v) {
        out += r;
        k -= v;
      }
    }
    return type === "I" ? out.toUpperCase() : out;
  }
  return String(n);
}

/** One block of the body. */
function block(node: PmNode, key: number): ReactNode {
  switch (node.type) {
    case "paragraph":
      return paragraph(node, key, s.p);
    case "heading": {
      const level = node.attrs?.level === 2 ? s.h2 : node.attrs?.level === 3 ? s.h3 : s.h1;
      // A heading never ends a page alone.
      return (
        <Text key={key} style={level} minPresenceAhead={30}>
          {runs(node)}
        </Text>
      );
    }
    case "bulletList":
    case "orderedList": {
      const ordered = node.type === "orderedList";
      const start = typeof node.attrs?.start === "number" ? node.attrs.start : 1;
      const kind = typeof node.attrs?.type === "string" ? node.attrs.type : "1";
      // An item WRAPS across pages: a clause of several paragraphs taller than
      // a page would otherwise be placed whole and its overflow never drawn
      // (react-pdf's layout — the code review's low).
      return (
        <View key={key} style={s.list}>
          {children(node).map((item, i) => (
            <View key={i} style={s.item}>
              <Text style={s.marker}>{ordered ? `${listMarker(start + i, kind)}.` : "•"}</Text>
              <View style={s.itemBody}>{children(item).map((child, j) => listChild(child, j))}</View>
            </View>
          ))}
        </View>
      );
    }
    case "blockquote":
      return (
        <View key={key} style={s.quote}>
          {children(node).map((child, i) => block(child, i))}
        </View>
      );
    case "horizontalRule":
      return <View key={key} style={s.rule} />;
    default:
      return (
        <Text key={key} style={s.p}>
          {plain(node)}
        </Text>
      );
  }
}

/** Inside a list item a paragraph takes no bottom margin of its own. */
function listChild(node: PmNode, key: number): ReactNode {
  if (node.type === "paragraph") return paragraph(node, key, undefined);
  return block(node, key);
}

function Party({ label, party, t }: { readonly label: string; readonly party: ContractParty; readonly t: ReturnType<typeof translatorFor> }) {
  return (
    <View style={s.party}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.strong}>{party.name}</Text>
      {party.orgNr ? <Text>{t("orgNr", { value: party.orgNr })}</Text> : null}
      {party.address ? <Text>{party.address}</Text> : null}
    </View>
  );
}

/** The document, for `renderContractPdf` and the unit test. */
export function ContractPdf({ contract }: { readonly contract: ContractPrint }) {
  const t = translatorFor(contract.locale);
  const body = contract.body as PmNode | null;
  const version = t("version", { version: contract.version });
  return (
    <Document title={contract.title} language={contract.locale}>
      <Page size="A4" style={s.page}>
        {contract.draft ? (
          <Text style={s.draft} fixed>
            {t("draft")}
          </Text>
        ) : null}
        <Text style={s.title}>{contract.title}</Text>
        <Text style={s.version}>{version}</Text>
        <View style={s.parties} wrap={false}>
          <Party label={t("agency")} party={contract.parties.agency} t={t} />
          <Party label={t("client")} party={contract.parties.client} t={t} />
        </View>
        <View style={s.body}>{body ? children(body).map((node, i) => block(node, i)) : null}</View>
        <View style={s.foot} fixed>
          <Text>{`${contract.title} · ${version}`}</Text>
          <Text render={({ pageNumber, totalPages }) => t("page", { page: pageNumber, pages: totalPages })} />
        </View>
      </Page>
    </Document>
  );
}

export async function renderContractPdf(contract: ContractPrint): Promise<Uint8Array> {
  registerPdfFonts();
  const buffer = await renderToBuffer(<ContractPdf contract={contract} />);
  return new Uint8Array(buffer);
}
