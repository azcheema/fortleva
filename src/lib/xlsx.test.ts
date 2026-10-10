import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { columnName, excelDaySerial, sheetName, xlsxWorkbook, xmlText } from "./xlsx";

const parts = (bytes: Uint8Array) => {
  const files = unzipSync(bytes);
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
};

describe("xlsxWorkbook", () => {
  const book = () =>
    xlsxWorkbook({
      sheet: "Fakturor",
      columns: [
        { header: "Nummer", kind: "integer" },
        { header: "Kund", kind: "text" },
        { header: "Datum", kind: "date" },
        { header: "Belopp", kind: "money" },
        { header: "Kurs", kind: "rate" },
      ],
      rows: [
        ["10001", "Åkesson & <Söner> \"AB\"", "2026-10-10", "-1250.00", "10.512345"],
        ["10002", "=HYPERLINK(\"x\")", "2026-02-30", "not a number", null],
      ],
    });

  it("holds every part a spreadsheet program needs", () => {
    expect(Object.keys(parts(book())).sort()).toEqual(
      ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"].sort(),
    );
  });

  it("is the same bytes for the same rows (a re-download is identical)", () => {
    expect(Buffer.from(book()).equals(Buffer.from(book()))).toBe(true);
  });

  it("writes a bold frozen header and typed cells", () => {
    const sheet = parts(book())["xl/worksheets/sheet1.xml"]!;
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Nummer</t></is></c>');
    // Text escaped, never a formula; numbers as numbers; a day as its serial.
    expect(sheet).toContain("Åkesson &amp; &lt;Söner&gt; &quot;AB&quot;");
    expect(sheet).toContain('<c r="A2" s="5"><v>10001</v></c>');
    expect(sheet).toContain('<c r="C2" s="3"><v>46305</v></c>');
    expect(sheet).toContain('<c r="D2" s="2"><v>-1250.00</v></c>');
    expect(sheet).toContain('<c r="E2" s="4"><v>10.512345</v></c>');
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain("=HYPERLINK(&quot;x&quot;)</t>");
    // What does not fit its column is left empty, never guessed.
    expect(sheet).not.toContain('r="C3"');
    expect(sheet).not.toContain('r="D3"');
    expect(sheet).not.toContain('r="E3"');
  });

  it("names its sheet", () => {
    expect(parts(book())["xl/workbook.xml"]).toContain('<sheet name="Fakturor" sheetId="1" r:id="rId1"/>');
  });
});

describe("the helpers", () => {
  it("drops what XML 1.0 forbids and keeps the rest", () => {
    const bell = String.fromCharCode(7);
    const nul = String.fromCharCode(0);
    const loneSurrogate = String.fromCharCode(0xd800);
    expect(xmlText(`a${bell}b${nul}c${loneSurrogate}d`)).toBe("abcd");
    expect(xmlText("tab\tline\nret\r")).toBe("tab\tline\nret\r");
    expect(xmlText("😀 & 'x'")).toBe("😀 &amp; &apos;x&apos;");
  });

  it("names columns past Z", () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });

  it("counts days as Excel does", () => {
    expect(excelDaySerial("1900-03-01")).toBe(61);
    expect(excelDaySerial("2026-10-10")).toBe(46305);
    expect(excelDaySerial("2026-02-30")).toBeNull();
    expect(excelDaySerial("10/10/2026")).toBeNull();
  });

  it("makes a sheet name Excel accepts", () => {
    expect(sheetName("Q1/Q2: [draft]?")).toBe("Q1 Q2   draft");
    expect(sheetName("x".repeat(40))).toHaveLength(31);
    expect(sheetName("   ")).toBe("Sheet1");
    // Cut first, escaped after: an entity is never cut in half.
    expect(sheetName(`${"x".repeat(29)}&&&`)).toBe(`${"x".repeat(29)}&amp;&amp;`);
  });
});
