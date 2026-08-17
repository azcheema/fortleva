import { describe, expect, it } from "vitest";

import { chosenFileFrom, describeChosenFile, truncateFileName } from "./file-field";
import { normalizeNbsp } from "./format";

/** A FileList is DOM-only; the shape the helper actually reads is not. */
const fileList = (...files: { name: string; size: number }[]): FileList =>
  ({ ...files, length: files.length, item: (i: number) => files[i] ?? null }) as unknown as FileList;

describe("chosenFileFrom", () => {
  it("takes the first file", () => {
    expect(chosenFileFrom(fileList({ name: "a.pdf", size: 10 }, { name: "b.pdf", size: 20 }))).toEqual({
      name: "a.pdf",
      size: 10,
    });
  });

  it("returns null — never undefined — for no selection", () => {
    expect(chosenFileFrom(fileList())).toBeNull();
    expect(chosenFileFrom(null)).toBeNull();
    expect(chosenFileFrom(undefined)).toBeNull();
  });
});

describe("describeChosenFile", () => {
  it("states name and size, in the reader's locale", () => {
    // formatBytes joins value and unit with U+00A0 so a size never wraps.
    expect(normalizeNbsp(describeChosenFile("en", { name: "report.pdf", size: 1_200_000 }))).toBe(
      "report.pdf · 1.20 MB",
    );
    expect(normalizeNbsp(describeChosenFile("sv", { name: "rapport.pdf", size: 1_200_000 }))).toBe(
      "rapport.pdf · 1,20 MB",
    );
  });

  it("keeps whole bytes whole", () => {
    expect(normalizeNbsp(describeChosenFile("en", { name: "note.txt", size: 812 }))).toBe("note.txt · 812 B");
  });
});

describe("truncateFileName", () => {
  it("leaves a short name alone", () => {
    expect(truncateFileName("report.pdf")).toBe("report.pdf");
  });

  it("keeps the extension when it cuts", () => {
    const out = truncateFileName("a-very-long-quarterly-financial-report-2026-final.pdf", 24);
    expect(out).toHaveLength(24);
    expect(out.endsWith(".pdf")).toBe(true);
    expect(out).toContain("…");
  });

  it("cuts the head when there is no usable extension", () => {
    expect(truncateFileName("no-extension-at-all-whatsoever", 10)).toBe("no-extens…");
  });

  it("does not treat a dotfile as an extension", () => {
    expect(truncateFileName(".averylongdotfilename", 10)).toBe(".averylon…");
  });

  it("degrades rather than throwing at absurd budgets", () => {
    expect(truncateFileName("report.pdf", 1)).toBe("…");
    expect(truncateFileName("report.pdf", 5)).toBe("repo…");
  });
});
