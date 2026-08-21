import { describe, expect, it } from "vitest";

import { CSV_BOM, csvCell, csvFileStem, toCsv } from "./csv";

describe("csv — RFC 4180 with the machine number format and the injection guard", () => {
  it("quotes only what must be quoted and doubles inner quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(" padded ")).toBe('" padded "');
    expect(csvCell("")).toBe("");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("numbers print in machine form (dot decimal, no grouping); booleans as true/false", () => {
    expect(csvCell(1234.5)).toBe("1234.5");
    expect(csvCell(-2)).toBe("-2");
    expect(csvCell(Number.NaN)).toBe("");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(false)).toBe("false");
  });

  it("neutralises formula injection in text cells — a note is never a formula in the reader's sheet", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+46 70 000 00 00")).toBe("'+46 70 000 00 00");
    expect(csvCell("-1 not a number")).toBe("'-1 not a number");
    expect(csvCell("@mention")).toBe("'@mention");
    expect(csvCell("\tTab")).toBe("'\tTab");
    // Leading whitespace does not hide a formula.
    expect(csvCell(" =1+1")).toBe("' =1+1"); // the apostrophe now leads, so no quoting is needed
    // Numbers are exempt: a negative amount stays a number — as a number or as a machine-number string ("-500.00" from money()).
    expect(csvCell(-12.5)).toBe("-12.5");
    expect(csvCell("-500.00")).toBe("-500.00");
    expect(csvCell("-12")).toBe("-12");
    expect(csvCell("+1")).toBe("'+1"); // a plus sign is not part of the machine format
  });

  it("toCsv: BOM first, CRLF line ends, trailing line end, header then rows", () => {
    const out = toCsv(["a", "b"], [["x", 1], [null, "y,z"]]);
    expect(out.startsWith(CSV_BOM)).toBe(true);
    expect(out.slice(1)).toBe('a,b\r\nx,1\r\n,"y,z"\r\n');
  });

  it("csvFileStem: ASCII-safe, collapsed, trimmed, never empty", () => {
    expect(csvFileStem("time", "Åsa Öberg", "2026-08")).toBe("time-Asa-Oberg-2026-08");
    expect(csvFileStem("a/b\\c", "..x..")).toBe("a-b-c-..x");
    expect(csvFileStem(null, undefined, "")).toBe("export");
  });
});
