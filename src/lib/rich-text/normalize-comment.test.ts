import { describe, expect, it } from "vitest";

import { DomainError } from "@/lib/domain-error";
import { mentionIdsIn } from "./mention-ids";
import { COMMENT_JSON_BYTES, COMMENT_TEXT_CHARS, MENTION_MAX, normalizeComment, normalizeDescription } from "./normalize";

/**
 * The comment half of the gatekeeper (panel slice 10): the comment
 * schema, the comment caps, and "a comment must say something". The
 * shared walk is `normalize.test.ts`'s; this pins only what differs.
 */

const doc = (...content: unknown[]) => ({ type: "doc", content });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });

const code = (e: unknown): string => (e instanceof DomainError ? e.code : String(e));

describe("normalizeComment", () => {
  it("keeps a plain comment and derives its text — never null", () => {
    const out = normalizeComment(doc(para(text("Looks good — ship it")), para(text("Then invoice"))));
    expect(out.text).toBe("Looks good — ship it\nThen invoice");
    expect(out.doc).toMatchObject({ type: "doc" });
  });

  it("refuses an empty comment as COMMENT_EMPTY, where a description is a legitimate nothing", () => {
    expect(normalizeDescription(doc(para()))).toMatchObject({ doc: null });
    expect(() => normalizeComment(doc(para()))).toThrow(DomainError);
    try {
      normalizeComment(doc(para(text("   "))));
      expect.unreachable();
    } catch (e) {
      expect(code(e)).toBe("COMMENT_EMPTY");
    }
  });

  it("refuses the nodes the comment schema does not declare: a heading, a checklist", () => {
    // Both are legal in a DESCRIPTION — the same JSON, two answers.
    const heading = doc({ type: "heading", attrs: { level: 2 }, content: [text("Plan")] }, para(text("body")));
    expect(normalizeDescription(heading).doc).not.toBeNull();
    expect(() => normalizeComment(heading)).toThrow(DomainError);
    const checklist = doc({
      type: "taskList",
      content: [{ type: "taskItem", attrs: { checked: true }, content: [para(text("done"))] }],
    });
    expect(normalizeDescription(checklist).checklistTotal).toBe(1);
    expect(() => normalizeComment(checklist)).toThrow(DomainError);
  });

  it("keeps the inline marks and a safe link, and drops an unsafe one with its text intact", () => {
    const out = normalizeComment(
      doc(
        para(
          text("bold", [{ type: "bold" }]),
          text(" site", [{ type: "link", attrs: { href: "https://example.test/x", target: "_blank", class: "x" } }]),
          text(" evil", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
        ),
      ),
    );
    const marks = JSON.stringify(out.doc);
    expect(marks).toContain('"type":"bold"');
    expect(marks).toContain('"href":"https://example.test/x"');
    // The client's `class` did not survive (the re-parse fills the mark's
    // attributes from the SCHEMA's defaults — never from what was sent);
    // the unsafe link is gone with its mark, its text kept.
    expect(marks).not.toContain('"class":"x"');
    expect(marks).not.toContain("javascript:");
    expect(marks).toContain('"text":" evil"}');
    expect(out.text).toBe("bold site evil");
  });

  it("caps at the comment's own size with the comment's own code", () => {
    // Past the comment's TEXT cap, well under the description's.
    const big = doc(para(text("x".repeat(COMMENT_TEXT_CHARS + 1))));
    try {
      normalizeComment(big);
      expect.unreachable();
    } catch (e) {
      expect(code(e)).toBe("COMMENT_TOO_LARGE");
    }
    expect(normalizeDescription(big).text?.length).toBe(COMMENT_TEXT_CHARS + 1);
    // Past the comment's JSON cap on the way in, before any parse.
    const bytes = doc(para(text("y".repeat(COMMENT_JSON_BYTES))));
    try {
      normalizeComment(bytes);
      expect.unreachable();
    } catch (e) {
      expect(code(e)).toBe("COMMENT_TOO_LARGE");
    }
  });

  it("refuses what the editor cannot produce, with the description's own code", () => {
    for (const input of ["not a document", { type: "paragraph" }, doc({ type: "iframe" }), null, 42]) {
      try {
        normalizeComment(input);
        expect.unreachable();
      } catch (e) {
        expect(code(e)).toBe("INVALID_INPUT");
      }
    }
  });
});

/**
 * @mentions (slice 125, founder decision C101): the node stores a member id
 * and nothing else, the normaliser hands back who was mentioned, and no name
 * ever reaches the stored text.
 */
describe("normalizeComment — mentions", () => {
  const ANNA = "0192f1d2-0000-7000-8000-00000000a001";
  const BO = "0192f1d2-0000-7000-8000-00000000b002";
  const mention = (id: unknown, extra: Record<string, unknown> = {}) => ({ type: "mention", attrs: { id, ...extra } });

  it("keeps a mention's id and drops everything else on it — a label is a name", () => {
    const out = normalizeComment(doc(para(text("Over to "), mention(ANNA, { label: "Anna Andersson", class: "x" }), text(" now"))));
    expect(JSON.stringify(out.doc)).not.toContain("Anna");
    expect(out.doc).toEqual(
      doc(para(text("Over to "), { type: "mention", attrs: { id: ANNA } }, text(" now"))),
    );
    expect(out.mentions).toEqual([ANNA]);
  });

  it("hands back the people distinct and in order of first appearance", () => {
    const out = normalizeComment(doc(para(mention(BO), text(" and "), mention(ANNA)), para(mention(BO))));
    expect(out.mentions).toEqual([BO, ANNA]);
  });

  it("never puts a name into the text — a mention is a space there, so the search index holds no name", () => {
    const out = normalizeComment(doc(para(text("Ask"), mention(ANNA), text("today"))));
    expect(out.text).toBe("Ask today");
    expect(out.text).not.toContain(ANNA);
  });

  it("a comment of nothing but a mention says something (the person) and stores no text", () => {
    const out = normalizeComment(doc(para(mention(ANNA))));
    expect(out.mentions).toEqual([ANNA]);
    expect(out.text).toBe("");
    expect(out.doc).not.toBeNull();
  });

  it("refuses a mention with no id, or an id that is not a member id — a chip naming nobody", () => {
    for (const bad of [undefined, null, "", "Anna", 42, "0192F1D2-0000-7000-8000-00000000A001", `${ANNA} `]) {
      try {
        normalizeComment(doc(para(text("hi "), mention(bad))));
        expect.unreachable(String(bad));
      } catch (e) {
        expect(code(e), String(bad)).toBe("INVALID_INPUT");
      }
    }
  });

  it(`refuses more than ${MENTION_MAX} people in one comment, and counts a person once`, () => {
    const id = (n: number) => `0192f1d2-0000-7000-8000-${String(n).padStart(12, "0")}`;
    const many = (n: number) => doc(para(...Array.from({ length: n }, (_, i) => mention(id(i)))));
    expect(normalizeComment(many(MENTION_MAX)).mentions).toHaveLength(MENTION_MAX);
    expect(normalizeComment(doc(para(...Array.from({ length: 40 }, () => mention(ANNA))))).mentions).toEqual([ANNA]);
    try {
      normalizeComment(many(MENTION_MAX + 1));
      expect.unreachable();
    } catch (e) {
      expect(code(e)).toBe("TOO_MANY_MENTIONS");
    }
  });

  it("the refusal's copy names the cap the code holds, in both languages", async () => {
    const en = (await import("@/messages/en.json")).default as { domainErrors: Record<string, string> };
    const sv = (await import("@/messages/sv.json")).default as { domainErrors: Record<string, string> };
    expect(en.domainErrors["TOO_MANY_MENTIONS"]).toContain(String(MENTION_MAX));
    expect(sv.domainErrors["TOO_MANY_MENTIONS"]).toContain(String(MENTION_MAX));
  });

  it("the description's schema has no mention node — refused there", () => {
    try {
      normalizeDescription(doc(para(text("for "), mention(ANNA))));
      expect.unreachable();
    } catch (e) {
      expect(code(e)).toBe("INVALID_INPUT");
    }
  });

  it("mentionIdsIn reads the same people back off a stored body, and nothing off an odd shape", () => {
    const stored = normalizeComment(doc(para(mention(BO), text(" "), mention(ANNA), mention(BO)))).doc;
    expect(mentionIdsIn(stored)).toEqual([BO, ANNA]);
    for (const odd of [null, 42, "doc", { type: "mention" }, { type: "mention", attrs: null }, { content: "x" }]) {
      expect(mentionIdsIn(odd)).toEqual([]);
    }
  });
});
