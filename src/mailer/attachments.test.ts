import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { describeAttachments } from "./attachment";

/**
 * MAIL WITH A FILE IN IT (Phase 4 slice 109, founder decision C79 (a)). ARC-09
 * says our mail carries links, never data — with ONE exception: an issued
 * invoice or credit note goes to the client's accounts address with its
 * archived PDF attached. These pin that the exception stays one.
 */

const SRC = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|dbtest)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("who attaches a file to a mail", () => {
  it("only the invoice sender — every other mail stays links-only (ARC-09)", () => {
    const setters = sourceFiles(SRC)
      .filter((file) => /\battachments\s*[:?]/.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file).split(sep).join("/"))
      .sort();
    // The mailer itself (the type, the dev outbox's record of one) and the one
    // caller. SES's mapping reads `msg.attachments` and sets nothing by this name.
    expect(setters).toEqual(["mailer/attachment.ts", "mailer/index.ts", "modules/invoicing/send.ts"]);
  });

  it("no other mailer caller even mentions attachments — a shorthand `{ attachments }` included (the security review's nit)", () => {
    // Every file that imports the mailer (or its attachment type), outside the
    // mailer itself: only the invoice sender may name the word at all. The word
    // is common elsewhere (a task's attachments), so the walk is bounded by WHO
    // TALKS TO THE MAILER, not by the word.
    const callers = sourceFiles(SRC)
      .filter((file) => !relative(SRC, file).split(sep).join("/").startsWith("mailer/"))
      .filter((file) => /from\s+["']@\/mailer(?:\/[a-z-]+)?["']/.test(readFileSync(file, "utf8")));
    expect(callers.length).toBeGreaterThan(1);
    const mentioning = callers
      .filter((file) => /\battachments?\b|\bMailAttachment\b/.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file).split(sep).join("/"))
      .sort();
    expect(mentioning).toEqual(["modules/invoicing/send.ts"]);
  });
});

describe("the dev outbox's record of an attachment", () => {
  it("names the file, its type, size and hash — never its bytes", () => {
    const content = new TextEncoder().encode("%PDF-1.7 bank details 123-4567");
    const described = describeAttachments([{ filename: "faktura-10001.pdf", contentType: "application/pdf", content }]);
    expect(described).toEqual([
      {
        filename: "faktura-10001.pdf",
        contentType: "application/pdf",
        size: content.byteLength,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(JSON.stringify(described)).not.toContain("123-4567");
    expect(describeAttachments(undefined)).toBeUndefined();
  });
});
