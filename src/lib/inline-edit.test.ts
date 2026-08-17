import { describe, expect, it } from "vitest";

import {
  commitsOn,
  inlineEditInitial,
  inlineEditReducer,
  isActivationKey,
  optionLabel,
  returnsFocus,
  selectsOnFocus,
  type InlineEditEvent,
  type InlineEditState,
} from "./inline-edit";

const run = (start: InlineEditState, ...events: InlineEditEvent[]): InlineEditState =>
  events.reduce(inlineEditReducer, start);

describe("inline edit state machine", () => {
  it("starts at rest on the server value", () => {
    expect(inlineEditInitial("Kickoff")).toEqual({
      mode: "rest",
      value: "Kickoff",
      invalid: false,
    });
  });

  it("activate opens the editor without touching the posted value", () => {
    const s = run(inlineEditInitial("Kickoff"), { type: "activate" });
    expect(s).toEqual({ mode: "editing", value: "Kickoff", invalid: false });
  });

  it("activate is idempotent", () => {
    const once = run(inlineEditInitial("a"), { type: "activate" });
    expect(run(once, { type: "activate" })).toBe(once);
  });

  it("cancel returns to rest and keeps the value that was there", () => {
    const s = run(inlineEditInitial("Kickoff"), { type: "activate" }, { type: "cancel" });
    expect(s).toEqual({ mode: "rest", value: "Kickoff", invalid: false });
  });

  it("commit moves the posted value, so the hidden input carries what was saved", () => {
    const s = run(
      inlineEditInitial("Kickoff"),
      { type: "activate" },
      { type: "commit", value: "Kickoff v2" },
    );
    expect(s).toEqual({ mode: "rest", value: "Kickoff v2", invalid: false });
  });

  it("a failed save keeps the edited value and stays open", () => {
    const s = run(
      inlineEditInitial("Kickoff"),
      { type: "activate" },
      { type: "commit", value: "" },
      { type: "fail" },
    );
    expect(s).toEqual({ mode: "editing", value: "", invalid: true });
    // the shipped bug this replaces: value must NOT snap back to "Kickoff"
    expect(s.value).not.toBe("Kickoff");
  });

  it("a fresh server render is authoritative and clears the failure", () => {
    const failed = run(
      inlineEditInitial("Kickoff"),
      { type: "activate" },
      { type: "commit", value: "" },
      { type: "fail" },
    );
    expect(run(failed, { type: "reseed", value: "Kickoff" })).toEqual({
      mode: "rest",
      value: "Kickoff",
      invalid: false,
    });
  });

  it("cancel after a failure clears the flag but never reverts the text", () => {
    const failed = run(inlineEditInitial("a"), { type: "activate" }, { type: "commit", value: "b" }, { type: "fail" });
    expect(run(failed, { type: "cancel" })).toEqual({ mode: "rest", value: "b", invalid: false });
  });
});

describe("inline edit commit triggers", () => {
  it("mirrors the two events AutoForm already listens for", () => {
    expect(commitsOn("select")).toBe("change");
    expect(commitsOn("text")).toBe("blur");
    expect(commitsOn("multiline")).toBe("blur");
    // AutoForm's isTextField() accepts type="date", so a date posts on blur.
    expect(commitsOn("date")).toBe("blur");
  });

  it("opens on Enter, Space and F2 only", () => {
    for (const key of ["Enter", " ", "Spacebar", "F2"]) expect(isActivationKey(key)).toBe(true);
    for (const key of ["Escape", "Tab", "a", "ArrowDown", "F3"]) expect(isActivationKey(key)).toBe(false);
  });

  it("selects all only where .select() is legal", () => {
    expect(selectsOnFocus("text")).toBe(true);
    expect(selectsOnFocus("multiline")).toBe(true);
    expect(selectsOnFocus("date")).toBe(false);
    expect(selectsOnFocus("select")).toBe(false);
  });

  it("returns focus to the trigger only when the blur named no successor", () => {
    expect(returnsFocus(null)).toBe(true);
    expect(returnsFocus(undefined)).toBe(true);
    expect(returnsFocus({})).toBe(false);
  });
});

describe("optionLabel", () => {
  const options = [
    { value: "INTERNAL", label: "Private to team" },
    { value: "CLIENT_VISIBLE", label: "Client can see" },
  ];

  it("renders the label, not the enum", () => {
    expect(optionLabel(options, "CLIENT_VISIBLE")).toBe("Client can see");
  });

  it("falls back to the raw value rather than rendering nothing", () => {
    expect(optionLabel(options, "MYSTERY")).toBe("MYSTERY");
    expect(optionLabel(undefined, "MYSTERY")).toBe("MYSTERY");
  });
});
