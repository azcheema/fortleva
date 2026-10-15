import { describe, expect, it } from "vitest";

import { CSV_MAX_ROWS, cleanCell, decodeCsv, detectDelimiter, parseCsv } from "./csv-parse";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("decodeCsv", () => {
  it("strips a UTF-8 BOM", () => {
    expect(decodeCsv(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("Namn;Status")]))).toBe("Namn;Status");
  });

  it("falls back to Windows-1252 when the bytes are not UTF-8 (a Swedish Excel save)", () => {
    // "Åtgärd" in Windows-1252: Å = 0xC5, ä = 0xE4 — invalid as UTF-8.
    const win1252 = new Uint8Array([0xc5, 0x74, 0x67, 0xe4, 0x72, 0x64]);
    expect(decodeCsv(win1252)).toBe("Åtgärd");
  });

  it("reads UTF-8 as UTF-8, never as 1252", () => {
    expect(decodeCsv(bytes("Åtgärd"))).toBe("Åtgärd");
  });
});

describe("detectDelimiter", () => {
  it("picks the most frequent separator on the first record", () => {
    expect(detectDelimiter("a;b;c\n1,2;3;4")).toBe(";");
    expect(detectDelimiter("a,b,c\n1;2")).toBe(",");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
  });

  it("ignores separators inside quotes", () => {
    expect(detectDelimiter('"a,b,c";d\n')).toBe(";");
  });

  it("defaults to the comma", () => {
    expect(detectDelimiter("one column\nvalue")).toBe(",");
  });
});

describe("parseCsv", () => {
  it("reads quoted cells with separators, doubled quotes and line breaks inside", () => {
    const csv = parseCsv('Name,Notes\n"Fix, header","Line one\nLine ""two"""\nPlain,x\n');
    expect(csv.headers).toEqual(["Name", "Notes"]);
    expect(csv.rows).toEqual([
      ["Fix, header", 'Line one\nLine "two"'],
      ["Plain", "x"],
    ]);
  });

  it("accepts CR, LF and CRLF line ends", () => {
    expect(parseCsv("a,b\r\n1,2\r3,4\n5,6").rows).toEqual([
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ]);
  });

  it("drops blank records and separator-only padding, pads short rows and cuts long ones", () => {
    const csv = parseCsv("a;b;c\n\n1;2\n;;\n4;5;6;7\n", ";");
    expect(csv.rows).toEqual([
      ["1", "2", ""],
      ["4", "5", "6"],
    ]);
  });

  it("treats a quote mid-cell as a literal character", () => {
    expect(parseCsv('a,b\n5" screen,x').rows).toEqual([['5" screen', "x"]]);
  });

  it(`refuses beyond ${CSV_MAX_ROWS} rows by saying so, never by truncating silently`, () => {
    const lines = ["name", ...Array.from({ length: CSV_MAX_ROWS + 1 }, (_, i) => `task ${i}`)];
    const csv = parseCsv(lines.join("\n"));
    expect(csv.tooMany).toBe(true);
    expect(csv.rows.length).toBeLessThanOrEqual(CSV_MAX_ROWS);
    const ok = parseCsv(lines.slice(0, CSV_MAX_ROWS + 1).join("\n"));
    expect(ok.tooMany).toBe(false);
    expect(ok.rows).toHaveLength(CSV_MAX_ROWS);
  });

  it("removes what Postgres cannot store and NFC-normalises", () => {
    expect(cleanCell("a\u0000b")).toBe("ab");
    expect(cleanCell("x\uD800y")).toBe("xy");
    expect(cleanCell("A\u030A")).toBe("Å");
  });
});
