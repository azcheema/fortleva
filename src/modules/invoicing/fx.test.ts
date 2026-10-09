import { describe, expect, it } from "vitest";

import { DomainError } from "@/lib/domain-error";

import { latestSekRate, needsSekVat, parseEcbDaily, sekPerUnit, vatGroupsInSek, vatInSek } from "./fx";

const FILE = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
	<gesmes:subject>Reference rates</gesmes:subject>
	<Cube>
		<Cube time='2026-10-08'>
			<Cube currency='USD' rate='1.1186'/>
			<Cube currency='GBP' rate='0.84698'/>
			<Cube currency='SEK' rate='11.1940'/>
			<Cube currency='NOK' rate='10.7170'/>
		</Cube>
	</Cube>
</gesmes:Envelope>`;

describe("the ECB's daily file", () => {
  it("reads the date and every currency's rate per euro", () => {
    const daily = parseEcbDaily(FILE);
    expect(daily.date).toBe("2026-10-08");
    expect(daily.perEur.get("USD")).toBe("1.1186");
    expect(daily.perEur.get("SEK")).toBe("11.1940");
  });

  it("refuses a file with no date or no SEK", () => {
    expect(() => parseEcbDaily("<Cube><Cube currency='SEK' rate='11.1'/></Cube>")).toThrow();
    expect(() => parseEcbDaily("<Cube time='2026-10-08'><Cube currency='USD' rate='1.1'/></Cube>")).toThrow();
  });
});

describe("SEK per unit, in millionths", () => {
  const daily = parseEcbDaily(FILE);

  it("is the file's SEK figure for the euro", () => {
    expect(sekPerUnit(daily, "EUR")).toBe(11_194_000n); // 11.194000
  });

  it("is the cross rate SEK/EUR ÷ CUR/EUR for any other currency, rounded half away from zero", () => {
    // 11.1940 / 1.1186 = 10.007151797…
    expect(sekPerUnit(daily, "USD")).toBe(10_007_152n);
    // 11.1940 / 0.84698 = 13.216368745…
    expect(sekPerUnit(daily, "GBP")).toBe(13_216_369n);
  });

  it("refuses a currency the file does not carry", () => {
    expect(() => sekPerUnit(daily, "XYZ")).toThrow(DomainError);
  });
});

describe("the VAT in SEK", () => {
  it("is each rate's VAT × the rate, to the öre, and the total their sum", () => {
    // 1 234,56 EUR of VAT at 11.194000 = 13 819,664… → 13 819,66
    expect(vatInSek(123_456n, 11_194_000n)).toBe(1_381_966n);
    const { groups, totalSek } = vatGroupsInSek(
      [
        { rate: 2500n, net: 400_000n, vat: 100_000n },
        { rate: 600n, net: 10_000n, vat: 600n },
      ],
      11_194_000n,
    );
    expect(groups.map((g) => g.vatSek)).toEqual([1_119_400n, 6_716n]);
    expect(totalSek).toBe(1_126_116n);
  });

  it("rounds half away from zero, as Postgres's round does", () => {
    // 0,05 × 10.000000 is exact; 0,01 × 10.500000 = 0,105 → 0,11; a negative mirrors it.
    expect(vatInSek(1n, 10_500_000n)).toBe(11n);
    expect(vatInSek(-1n, 10_500_000n)).toBe(-11n);
  });

  it("is wanted only for another currency carrying VAT", () => {
    expect(needsSekVat("SEK", 2500n)).toBe(false);
    expect(needsSekVat("EUR", 0n)).toBe(false);
    expect(needsSekVat("EUR", 2500n)).toBe(true);
  });
});

describe("latestSekRate", () => {
  it("reads the file through the given fetch", async () => {
    const rate = await latestSekRate("USD", { fetchText: () => Promise.resolve(FILE) });
    expect(rate).toEqual({ micros: 10_007_152n, date: "2026-10-08" });
  });

  it("turns any failure to fetch or read the file into a sentence, never a guessed rate", async () => {
    await expect(latestSekRate("USD", { fetchText: () => Promise.reject(new Error("offline")) })).rejects.toMatchObject({
      code: "INVOICE_FX_UNAVAILABLE",
    });
    await expect(latestSekRate("USD", { fetchText: () => Promise.resolve("<html>maintenance</html>") })).rejects.toMatchObject({
      code: "INVOICE_FX_UNAVAILABLE",
    });
  });
});
