import { describe, expect, it } from "vitest";

import { normalizeUpdateSection } from "@/lib/rich-text/normalize";

import type { MadeReportContent } from "./made-report-shape";
import { madeReportFileName, madeReportName, monthLabel, renderMadeReportPdf, type MadeReportPrint } from "./pdf/made-report-pdf";

/**
 * The monthly report's PDF (Phase 7 slice 119): both languages render with
 * Inter embedded, every node of the section schema is drawn (a checklist, a
 * code block and a newline inside a text among them), an empty report and a
 * long one render too.
 */

const text = (t: string, marks?: unknown[]) => (marks ? { type: "text", text: t, marks } : { type: "text", text: t });
const para = (...content: unknown[]) => ({ type: "paragraph", content });

/** Every node and mark the description schema allows, through the real normaliser. */
const EVERYTHING = normalizeUpdateSection({
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [text("What we did")] },
    para(
      text("Plain, "),
      text("bold", [{ type: "bold" }]),
      text(", "),
      text("italic", [{ type: "italic" }]),
      text(", "),
      text("underlined", [{ type: "underline" }]),
      text(", "),
      text("struck", [{ type: "strike" }]),
      text(", "),
      text("code", [{ type: "code" }]),
      text(" and "),
      text("a link", [{ type: "link", attrs: { href: "https://example.com/report" } }]),
      { type: "hardBreak" },
      text("Łódź Sp. z o.o. — Åsa Öberg"),
    ),
    para(text("A text with\na newline inside it")),
    { type: "paragraph" },
    { type: "heading", attrs: { level: 2 }, content: [text("Next")] },
    {
      type: "orderedList",
      attrs: { start: 3, type: "a" },
      content: [
        { type: "listItem", content: [para(text("Third"))] },
        {
          type: "listItem",
          content: [para(text("Fourth, nested")), { type: "bulletList", content: [{ type: "listItem", content: [para(text("Nested"))] }] }],
        },
      ],
    },
    {
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { checked: true }, content: [para(text("Done thing"))] },
        { type: "taskItem", attrs: { checked: false }, content: [para(text("Open thing"))] },
      ],
    },
    { type: "heading", attrs: { level: 3 }, content: [text("Notes")] },
    { type: "blockquote", content: [para(text("Quoted"))] },
    { type: "codeBlock", attrs: { language: "sql" }, content: [text("SELECT 1;\nSELECT 2;")] },
    { type: "horizontalRule" },
    // Slice 132 (C109): a table — a header row, a merged header cell, a
    // bold cell, a cell holding a list.
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", attrs: { colspan: 2 }, content: [para(text("Page and owner"))] },
            { type: "tableHeader", content: [para(text("Status"))] },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", attrs: { rowspan: 2 }, content: [para(text("Home"))] },
            { type: "tableCell", content: [para(text("Åsa", [{ type: "bold" }]))] },
            {
              type: "tableCell",
              content: [{ type: "bulletList", content: [{ type: "listItem", content: [para(text("Live"))] }] }],
            },
          ],
        },
        // Under "Home" (merged down): its first column is an empty box.
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [para(text("Bo"))] },
            { type: "tableCell", content: [para(text("Draft"))] },
          ],
        },
      ],
    },
    para(text("The end.")),
  ],
}).doc;

const content = (over: Partial<MadeReportContent> = {}): MadeReportContent => ({
  month: "2026-09-01",
  projects: [
    {
      id: "p1",
      name: "Website",
      health: "AT_RISK",
      tasks: [
        { id: "t1", title: "Launch the campaign page", completedOn: "2026-09-12" },
        { id: "t2", title: "Fix the checkout", completedOn: "2026-09-20" },
      ],
      updates: [
        {
          id: "u1",
          seq: 4,
          health: "AT_RISK",
          title: "Week 37",
          publishedOn: "2026-09-13",
          periodStart: "2026-09-07",
          periodEnd: "2026-09-13",
          editNote: "Corrected the launch date.",
          sections: [
            { key: "SUMMARY", title: null, body: EVERYTHING },
            { key: "CUSTOM", title: "SEO this month", body: { type: "doc", content: [para(text("Rankings up."))] } },
          ],
        },
      ],
    },
    { id: "p2", name: "Idle project", health: null, tasks: [], updates: [] },
  ],
  ...over,
});

const print = (over: Partial<MadeReportPrint> = {}): MadeReportPrint => ({
  locale: "sv",
  clientName: "Acme AB",
  agencyName: "Naxdor AB",
  madeOn: "2026-10-03",
  summary: "En bra månad.\n\nTvå rader.",
  comingNext: "Lansering i oktober.",
  content: content(),
  ...over,
});

describe("the monthly report's PDF", () => {
  it("normalises the fixture (every node the schema allows)", () => {
    expect(EVERYTHING).not.toBeNull();
  });

  it.each(["sv", "en"] as const)("renders every node and mark in %s, with Inter embedded", async (locale) => {
    const bytes = await renderMadeReportPdf(print({ locale }));
    const pdf = Buffer.from(bytes).toString("latin1");
    expect(pdf.slice(0, 5)).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(3_000);
    expect(pdf).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Inter-Regular/);
    expect(pdf).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Inter-SemiBold/);
    expect(pdf).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Inter-Italic/);
    expect(pdf).not.toMatch(/\/BaseFont\s*\/Helvetica/);
  });

  it("renders a report with no texts and an empty project list", async () => {
    const bytes = await renderMadeReportPdf(print({ summary: null, comingNext: null, content: content({ projects: [] }) }));
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
  });

  it("renders a long report over many pages", async () => {
    const p = content().projects[0]!;
    const long = content({
      projects: Array.from({ length: 12 }, (_, i) => ({
        ...p,
        id: `p${i}`,
        name: `Project ${i + 1}`,
        tasks: Array.from({ length: 40 }, (_, j) => ({ id: `t${i}-${j}`, title: `Task ${j + 1} of project ${i + 1}`, completedOn: "2026-09-10" })),
      })),
    });
    const bytes = await renderMadeReportPdf(print({ content: long }));
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(Buffer.from(bytes).toString("latin1").match(/\/Type\s*\/Page\b/g)!.length).toBeGreaterThan(5);
  });

  it("names the document and the file in the report's language", () => {
    expect(monthLabel("2026-09-01", "en")).toBe("September 2026");
    expect(monthLabel("2026-09-01", "sv")).toBe("september 2026");
    expect(madeReportName("2026-09-01", "en")).toBe("Monthly report September 2026");
    expect(madeReportName("2026-09-01", "sv")).toBe("Månadsrapport september 2026");
    expect(madeReportFileName("2026-09-01", "en")).toBe("monthly-report-2026-09.pdf");
    expect(madeReportFileName("2026-09-01", "sv")).toBe("manadsrapport-2026-09.pdf");
  });
});
