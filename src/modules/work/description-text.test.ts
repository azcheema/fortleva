import { describe, expect, it } from "vitest";

import { DomainError } from "@/lib/domain-error";
import { DESCRIPTION_TEXT_CHARS } from "@/lib/rich-text/normalize";
import { MAX_DESCRIPTION_TEXT } from "@/lib/work-view";

import { descriptionFromText } from "./description-text";

/**
 * The "New task" form's description (slice 129, C106 (c)): plain text made a
 * description on the server, through the one gate.
 */
describe("descriptionFromText", () => {
  it("says nothing for text that says nothing", () => {
    expect(descriptionFromText("")).toBeNull();
    expect(descriptionFromText("   \n\n  \t")).toBeNull();
  });

  it("paragraphs, a checklist and a link become their nodes, and the counters follow the checklist", () => {
    const n = descriptionFromText("Call the client.\n\n- [ ] send the brief\n- [x] book the room\n\nSee https://example.com/a.");
    expect(n).not.toBeNull();
    expect(n!.checklistTotal).toBe(2);
    expect(n!.checklistDone).toBe(1);
    expect(n!.text).toContain("Call the client.");
    const json = JSON.stringify(n!.doc);
    expect(json).toContain('"taskList"');
    expect(json).toContain('"href":"https://example.com/a"');
  });

  it("removes what the database cannot store rather than refusing the text", () => {
    const n = descriptionFromText(`before${String.fromCharCode(0)}after`);
    expect(n!.text).toBe("beforeafter");
  });

  it("is refused past the gate's bound, never cut short", () => {
    const tooLong = "a ".repeat(DESCRIPTION_TEXT_CHARS);
    expect(() => descriptionFromText(tooLong)).toThrow(DomainError);
  });

  it("the form's box is bounded by the gate's own number", () => {
    expect(MAX_DESCRIPTION_TEXT).toBe(DESCRIPTION_TEXT_CHARS);
  });
});
