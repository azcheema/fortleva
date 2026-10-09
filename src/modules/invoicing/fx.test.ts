import { describe, expect, it } from "vitest";

import { DomainError } from "@/lib/domain-error";

import { needsSekVat, parseEcbDaily, parseEcbDays, rateDayFor, rateDayTooOld, sekPerUnit, sekRateFor, vatGroupsInSek, vatInSek } from "./fx";

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

/** The 90-day history file's shape: one dated cube per business day, newest first, double-quoted. */
const HISTORY = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
<gesmes:subject>Reference rates</gesmes:subject>
<Cube>
<Cube time="2026-10-08"><Cube currency="USD" rate="1.1186"/><Cube currency="SEK" rate="11.1940"/></Cube>
<Cube time="2026-10-07"><Cube currency="USD" rate="1.1200"/><Cube currency="SEK" rate="11.2000"/></Cube>
<Cube time="2026-10-02"><Cube currency="USD" rate="1.1000"/><Cube currency="SEK" rate="11.0000"/></Cube>
<Cube time="2026-07-10"><Cube currency="USD" rate="1.0500"/><Cube currency="SEK" rate="11.5500"/></Cube>
</Cube>
</gesmes:Envelope>`;

describe("the ECB's history file", () => {
  it("reads every dated cube, newest first", () => {
    const days = parseEcbDays(HISTORY);
    expect(days.map((d) => d.date)).toEqual(["2026-10-08", "2026-10-07", "2026-10-02", "2026-07-10"]);
    expect(days[1]!.perEur.get("SEK")).toBe("11.2000");
  });

  it("refuses a day without SEK, a day that is not one, or a day twice — never skips it", () => {
    expect(() => parseEcbDays(`<Cube time="2026-10-08"><Cube currency="USD" rate="1.1"/></Cube>`)).toThrow();
    expect(() => parseEcbDays(`<Cube time="2026-02-30"><Cube currency="SEK" rate="11.1"/></Cube>`)).toThrow();
    const day = `<Cube time="2026-10-08"><Cube currency="SEK" rate="11.1"/></Cube>`;
    expect(() => parseEcbDays(day + day)).toThrow();
  });

  it("refuses a currency twice in a day, a day inside a day, a day that never closes", () => {
    expect(() => parseEcbDays(`<Cube time="2026-10-08"><Cube currency="SEK" rate="11.1"/><Cube currency="SEK" rate="9.9"/></Cube>`)).toThrow();
    expect(() =>
      parseEcbDays(`<Cube time="2026-10-08"><Cube currency="SEK" rate="11.1"/><Cube time="2026-10-07"><Cube currency="SEK" rate="9.9"/></Cube>`),
    ).toThrow();
    expect(() => parseEcbDays(`<Cube time="2026-10-08"><Cube currency="SEK" rate="11.1"/>`)).toThrow();
  });

  it("reads a hostile file in linear time (the security review's low: openers with no closer)", () => {
    const hostile = `<Cube time="2026-10-08">`.repeat(22_000);
    const started = performance.now();
    expect(() => parseEcbDays(hostile)).toThrow();
    // …and with one closer at the very end (one indexOf, then "a day inside a day").
    expect(() => parseEcbDays(`${hostile}</Cube>`)).toThrow();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("is never read as the daily file (the design review's medium: every day folded into one, the oldest winning)", () => {
    expect(() => parseEcbDaily(HISTORY)).toThrow();
  });
});

describe("the day whose rate it takes (C78 (a))", () => {
  it("is the work period's last day, the invoice date without one, never after the invoice date", () => {
    expect(rateDayFor("2026-10-09", "2026-09-30")).toBe("2026-09-30");
    expect(rateDayFor("2026-10-09", null)).toBe("2026-10-09");
    expect(rateDayFor("2026-10-09", "2026-10-31")).toBe("2026-10-09");
    expect(rateDayFor("2026-10-09", "2026-10-09")).toBe("2026-10-09");
  });

  it("is too old past the ECB's 90 days of history", () => {
    expect(rateDayTooOld("2026-07-11", "2026-10-09")).toBe(false); // 90 days before
    expect(rateDayTooOld("2026-07-10", "2026-10-09")).toBe(true);
  });
});

describe("sekRateFor", () => {
  const today = { rateDay: "2026-10-09", issueDate: "2026-10-09" };

  it("reads today's file when the work ended on the invoice date", async () => {
    let asked = "";
    const rate = await sekRateFor("USD", today, {
      fetchText: (url) => {
        asked = url;
        return Promise.resolve(FILE);
      },
    });
    expect(rate).toEqual({ micros: 10_007_152n, date: "2026-10-08" });
    expect(asked).toMatch(/eurofxref-daily\.xml$/);
  });

  it("reads the history file for an earlier day: that day's rate, or the last business day's before it", async () => {
    let asked = "";
    const fetchText = (url: string) => {
      asked = url;
      return Promise.resolve(HISTORY);
    };
    // The work ended on a business day: that day's file.
    expect(await sekRateFor("EUR", { rateDay: "2026-10-07", issueDate: "2026-10-09" }, { fetchText })).toEqual({
      micros: 11_200_000n,
      date: "2026-10-07",
    });
    expect(asked).toMatch(/eurofxref-hist-90d\.xml$/);
    // …on a Sunday (and a TARGET gap): the last file before it.
    expect(await sekRateFor("EUR", { rateDay: "2026-10-05", issueDate: "2026-10-09" }, { fetchText })).toEqual({
      micros: 11_000_000n,
      date: "2026-10-02",
    });
  });

  it("refuses a day the history does not reach, in a sentence of its own", async () => {
    const fetchText = () => Promise.resolve(HISTORY.replace(/<Cube time="2026-07-10">.*<\/Cube>\n/, ""));
    await expect(sekRateFor("EUR", { rateDay: "2026-08-01", issueDate: "2026-10-09" }, { fetchText })).rejects.toMatchObject({
      code: "INVOICE_FX_TOO_OLD",
    });
    // Past 90 days nothing is fetched at all.
    const never = () => Promise.reject(new Error("fetched"));
    await expect(sekRateFor("EUR", { rateDay: "2026-06-30", issueDate: "2026-10-09" }, { fetchText: never })).rejects.toMatchObject({
      code: "INVOICE_FX_TOO_OLD",
    });
  });

  it("turns any failure to fetch or read the file into a sentence, never a guessed rate", async () => {
    await expect(sekRateFor("USD", today, { fetchText: () => Promise.reject(new Error("offline")) })).rejects.toMatchObject({
      code: "INVOICE_FX_UNAVAILABLE",
    });
    await expect(sekRateFor("USD", today, { fetchText: () => Promise.resolve("<html>maintenance</html>") })).rejects.toMatchObject({
      code: "INVOICE_FX_UNAVAILABLE",
    });
    // A file dated after tomorrow is not the ECB's.
    await expect(
      sekRateFor("EUR", { rateDay: "2026-10-05", issueDate: "2026-10-05" }, { fetchText: () => Promise.resolve(FILE) }),
    ).rejects.toMatchObject({ code: "INVOICE_FX_UNAVAILABLE" });
  });
});
