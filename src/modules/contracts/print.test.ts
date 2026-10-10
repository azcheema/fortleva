import { describe, expect, it } from "vitest";

import { normalizeContractBody } from "@/lib/rich-text/normalize";

import { renderContractPdf } from "./pdf/contract-pdf";
import { contractPdfFileName, type ContractPrint } from "./print";

const text = (t: string, marks?: unknown[]) => (marks ? { type: "text", text: t, marks } : { type: "text", text: t });
const para = (...content: unknown[]) => ({ type: "paragraph", content });

/** Every node and mark the contract schema allows, through the real normaliser. */
const EVERYTHING = normalizeContractBody({
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [text("1. Scope")] },
    para(
      text("Plain, "),
      text("bold", [{ type: "bold" }]),
      text(", "),
      text("italic", [{ type: "italic" }]),
      text(", "),
      text("both", [{ type: "bold" }, { type: "italic" }]),
      text(", "),
      text("underlined", [{ type: "underline" }]),
      text(", "),
      text("struck", [{ type: "strike" }]),
      text(" and "),
      text("a link", [{ type: "link", attrs: { href: "https://example.com/terms" } }]),
      { type: "hardBreak" },
      text("Łódź Sp. z o.o. — Åsa Öberg"),
    ),
    { type: "paragraph" },
    { type: "heading", attrs: { level: 2 }, content: [text("Payment")] },
    {
      type: "orderedList",
      attrs: { start: 3 },
      content: [
        { type: "listItem", content: [para(text("Third"))] },
        {
          type: "listItem",
          content: [
            para(text("Fourth, with a nested list")),
            { type: "bulletList", content: [{ type: "listItem", content: [para(text("Nested"))] }] },
          ],
        },
      ],
    },
    { type: "heading", attrs: { level: 3 }, content: [text("Notes")] },
    { type: "blockquote", content: [para(text("Quoted"))] },
    { type: "horizontalRule" },
    para(text("The end.")),
  ],
}).doc;

const fixture = (overrides: Partial<ContractPrint> = {}): ContractPrint => ({
  locale: "sv",
  title: "Avtal om webbutveckling",
  version: 1,
  draft: false,
  parties: {
    agency: { name: "Naxdor AB", orgNr: "559000-0000", address: "Storgatan 1, 111 22 Stockholm" },
    client: { name: "Acme AB", orgNr: null, address: null },
  },
  body: EVERYTHING,
  ...overrides,
});

describe("the contract's PDF", () => {
  it("normalises the fixture (every node the schema allows)", () => {
    expect(EVERYTHING).not.toBeNull();
  });

  it.each(["sv", "en"] as const)("renders every node and mark in %s, with Inter embedded", async (locale) => {
    const bytes = await renderContractPdf(fixture({ locale }));
    const pdf = Buffer.from(bytes).toString("latin1");
    expect(pdf.slice(0, 5)).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(3_000);
    expect(pdf).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Inter-Regular/);
    expect(pdf).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Inter-SemiBold/);
    expect(pdf).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Inter-Italic/);
    expect(pdf).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Inter-SemiBoldItalic/);
    expect(pdf).not.toMatch(/\/BaseFont\s*\/Helvetica/);
  });

  it("renders a draft's preview and an empty body", async () => {
    const bytes = await renderContractPdf(fixture({ draft: true, body: null }));
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
  });

  it("renders a long contract over many pages", async () => {
    const long = normalizeContractBody({
      type: "doc",
      content: Array.from({ length: 300 }, (_, i) => para(text(`Clause ${i + 1}. ${"Lorem ipsum dolor sit amet. ".repeat(6)}`))),
    }).doc;
    const bytes = await renderContractPdf(fixture({ body: long }));
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(Buffer.from(bytes).toString("latin1").match(/\/Type\s*\/Page\b/g)!.length).toBeGreaterThan(5);
  });
});

describe("the contract schema", () => {
  it("refuses a checklist and code", () => {
    expect(() =>
      normalizeContractBody({ type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", content: [para(text("x"))] }] }] }),
    ).toThrow();
    expect(() => normalizeContractBody({ type: "doc", content: [{ type: "codeBlock", content: [text("x")] }] })).toThrow();
    expect(() => normalizeContractBody({ type: "doc", content: [para(text("x", [{ type: "code" }]))] })).toThrow();
  });

  it("allows an empty body (a blank draft), sent as an empty document or as null", () => {
    expect(normalizeContractBody({ type: "doc", content: [{ type: "paragraph" }] }).doc).toBeNull();
    expect(normalizeContractBody(null)).toEqual({ doc: null, text: null });
    expect(normalizeContractBody(undefined)).toEqual({ doc: null, text: null });
  });
});

describe("contractPdfFileName", () => {
  it("makes a safe, recognisable name", () => {
    expect(contractPdfFileName("Avtal om webbutveckling — Åsa", 2)).toBe("avtal-om-webbutveckling-asa-v2.pdf");
    expect(contractPdfFileName("///", 1)).toBe("contract-v1.pdf");
  });
});

describe("listMarker — an ordered list's marker as the editor shows it", () => {
  it("numbers, letters and roman numerals", async () => {
    const { listMarker } = await import("./pdf/contract-pdf");
    expect([1, 2, 10].map((n) => listMarker(n, "1"))).toEqual(["1", "2", "10"]);
    expect([1, 26, 27, 28].map((n) => listMarker(n, "a"))).toEqual(["a", "z", "aa", "ab"]);
    expect(listMarker(3, "A")).toBe("C");
    expect([1, 4, 9, 14, 1994].map((n) => listMarker(n, "i"))).toEqual(["i", "iv", "ix", "xiv", "mcmxciv"]);
    expect(listMarker(4, "I")).toBe("IV");
  });
});
