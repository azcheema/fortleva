import { describe, expect, it } from "vitest";

import type { FortnoxFileState } from "@/modules/invoicing";

import { fortnoxFileLine, type FileLineWords } from "./file-line";

const W: FileLineWords = {
  waiting: () => "Waiting for Fortnox",
  sending: (b, v) => `Sending to Fortnox — ${b} of ${v}`,
  done: (s, n) => `In Fortnox: ${s} ${n}`,
  byHand: (c) => `${c} booked by hand`,
  downloaded: (c) => `${c} handed over in a file`,
  notSent: (c) => `${c} not sent`,
  pdfs: (c) => `${c} PDFs to attach`,
};

const state = (patch: Partial<FortnoxFileState>): FortnoxFileState => ({
  vouchers: 2,
  booked: 0,
  done: 0,
  pdfsOwed: 0,
  waiting: 0,
  downloaded: 0,
  byHand: 0,
  live: true,
  series: null,
  from: null,
  to: null,
  ...patch,
});

describe("a Fortnox file's line (slices 114b, 114c)", () => {
  it("books nothing: no line", () => {
    expect(fortnoxFileLine(state({ vouchers: 0 }), W)).toBeNull();
  });

  it("while its connection sends: waiting, then k of n", () => {
    expect(fortnoxFileLine(state({ waiting: 2 }), W)).toBe("Waiting for Fortnox");
    expect(fortnoxFileLine(state({ waiting: 1, booked: 1, from: 1, to: 1, series: "F" }), W)).toBe("Sending to Fortnox — 1 of 2");
  });

  it("in Fortnox: its numbers, and the PDFs still owed (114b's words, unchanged)", () => {
    expect(fortnoxFileLine(state({ booked: 2, pdfsOwed: 2, series: "F", from: 1, to: 2 }), W)).toBe("In Fortnox: F 1–2 · 2 PDFs to attach");
    expect(fortnoxFileLine(state({ vouchers: 1, booked: 1, done: 1, series: "F", from: 7, to: 7 }), W)).toBe("In Fortnox: F 7");
  });

  it("a file all booked by hand says so — never 'In Fortnox:' with no numbers (114b's NIT)", () => {
    expect(fortnoxFileLine(state({ booked: 2, done: 2, byHand: 2 }), W)).toBe("2 booked by hand");
  });

  it("after a disconnect: what was booked, by hand, handed over and never sent", () => {
    expect(fortnoxFileLine(state({ vouchers: 5, booked: 2, done: 1, byHand: 1, downloaded: 1, waiting: 2, live: false, series: "F", from: 3, to: 3 }), W)).toBe(
      "In Fortnox: F 3 · 1 booked by hand · 1 handed over in a file · 2 not sent",
    );
    expect(fortnoxFileLine(state({ downloaded: 2, live: false }), W)).toBe("2 handed over in a file");
  });
});
