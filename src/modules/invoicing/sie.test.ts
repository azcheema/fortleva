import { describe, expect, it } from "vitest";

import { decodeCp437, sieField, sieFile, sieOrgNr, sieText } from "./sie";

const file = (vouchers: Parameters<typeof sieFile>[0]["vouchers"], orgNr: string | null = "556677-8899") =>
  sieFile({ company: { legalName: "Naxdor AB", orgNr }, madeOn: "2026-10-10", series: "B", vouchers });

const invoice = {
  date: "2026-10-09",
  text: "Faktura 10001 Åkesson Bygg AB",
  rows: [
    { account: "1510", amount: 125_000n },
    { account: "3001", amount: -100_000n },
    { account: "2611", amount: -25_000n },
  ],
};

describe("sieFile", () => {
  it("writes a 4I file in the spec's order, CRLF, CP437", () => {
    const bytes = file([invoice]);
    expect(decodeCp437(bytes)).toBe(
      [
        "#FLAGGA 0",
        '#PROGRAM "Fortleva" 1.0',
        "#FORMAT PC8",
        "#GEN 20261010",
        "#SIETYP 4",
        '#FNAMN "Naxdor AB"',
        "#ORGNR 556677-8899",
        "",
        '#VER "B" "" 20261009 "Faktura 10001 Åkesson Bygg AB"',
        "{",
        "#TRANS 1510 {} 1250.00",
        "#TRANS 3001 {} -1000.00",
        "#TRANS 2611 {} -250.00",
        "}",
        "",
      ].join("\r\n"),
    );
    // Å is 0x8F in code page 437 (§5.8), never UTF-8's two bytes.
    expect([...bytes]).toContain(0x8f);
    expect([...bytes]).not.toContain(0xc3);
  });

  it("leaves #ORGNR out when it is not known", () => {
    expect(decodeCp437(file([invoice], null))).not.toContain("#ORGNR");
  });

  it("refuses a voucher that does not balance, has no rows, or a bad account", () => {
    expect(() => file([{ ...invoice, rows: [{ account: "1510", amount: 1n }] }])).toThrow(/balances/);
    expect(() => file([{ ...invoice, rows: [] }])).toThrow(/rows/);
    expect(() => file([{ ...invoice, rows: [{ account: "151", amount: 0n }] }])).toThrow(/four digits/);
    expect(() => sieFile({ company: { legalName: "X", orgNr: null }, madeOn: "2026-10-10", series: "B 1", vouchers: [] })).toThrow(/series/);
  });
});

describe("text in a field", () => {
  it("carries the Swedish letters as CP437 bytes", () => {
    const bytes = sieFile({
      company: { legalName: "åäö ÅÄÖ é ü", orgNr: null },
      madeOn: "2026-10-10",
      series: "B",
      vouchers: [],
    });
    const line = decodeCp437(bytes).split("\r\n")[5];
    expect(line).toBe('#FNAMN "åäö ÅÄÖ é ü"');
    const at = [...bytes].indexOf(0x86); // å
    expect([...bytes].slice(at, at + 3)).toEqual([0x86, 0x84, 0x94]);
  });

  it("quotes, escapes a quote, and never lets a backslash escape the closing quote", () => {
    expect(sieField('Kalle "K" Anka')).toBe('"Kalle \\"K\\" Anka"');
    expect(sieField("Ends with \\")).toBe('"Ends with /"');
  });

  it("removes control characters and folds whitespace", () => {
    const bell = String.fromCharCode(7);
    expect(sieText(`a\tb\r\nc${bell}d   e `)).toBe("a b cd e");
  });

  it("composes a name typed decomposed — A + a combining ring is Å, never A?", () => {
    const ring = String.fromCharCode(0x30a);
    const acute = String.fromCharCode(0x301);
    expect(sieText(`A${ring}kesson`)).toBe("Åkesson");
    expect(sieText(`Caf${"e"}${acute}`)).toBe("Café");
    // A mark with nothing to sit on is dropped, never a "?".
    expect(sieText(`${ring}Bo`)).toBe("Bo");
  });

  it("spells what CP437 lacks the nearest way it can", () => {
    expect(sieText("Ørsted ø œ ł “quoted” – … 10 €")).toBe('Orsted o oe l "quoted" - ... 10 EUR');
    expect(sieText("Čapek Ångström Ș")).toBe("Capek Ångström S");
    expect(sieText("東京 😀")).toBe("?? ?");
  });
});

describe("sieOrgNr", () => {
  it("writes ten digits with the hyphen after the sixth", () => {
    expect(sieOrgNr("5566778899")).toBe("556677-8899");
    expect(sieOrgNr("556677-8899")).toBe("556677-8899");
    expect(sieOrgNr("19800101-1234")).toBe("800101-1234");
    expect(sieOrgNr("12345")).toBeNull();
    expect(sieOrgNr(null)).toBeNull();
  });
});
