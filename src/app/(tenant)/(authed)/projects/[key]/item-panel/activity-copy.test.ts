import { describe, expect, it } from "vitest";

import { activitySentence, type ActivityLookups, type ActivityRow } from "./activity-copy";

/**
 * Every branch of the sentence builder, with lookups that tag their
 * input so the test can see WHICH formatter each value went through —
 * a minute count rendered as a day, a state ref rendered raw, or a
 * member name that bypassed the lookup (and with it the component's
 * translated "Unknown") would read fine in a screenshot and wrong on
 * the screen.
 */
const look: ActivityLookups = {
  stateName: (ref, category) =>
    ref === "s-todo" ? "state:To do" : ref === "s-doing" ? "state:Doing" : `cat:${category}`,
  priority: (v) => `prio:${v}`,
  duration: (m) => `dur:${m}`,
  day: (iso) => `day:${iso}`,
  visibility: (v) => `vis:${v}`,
  member: (name) => `member:${name ?? "?"}`,
};

const row = (partial: Partial<ActivityRow> & { field: string }): ActivityRow => ({
  oldValue: null,
  newValue: null,
  oldRef: null,
  newRef: null,
  oldRefName: null,
  newRefName: null,
  ...partial,
});

describe("activitySentence", () => {
  it("the two rows without values", () => {
    expect(activitySentence(row({ field: "created" }), look)).toEqual({ key: "created" });
    expect(activitySentence(row({ field: "description" }), look)).toEqual({ key: "descriptionEdited" });
  });

  it("title: both sides as written, an empty side as the empty string, no sides as the fallback", () => {
    expect(activitySentence(row({ field: "title", oldValue: "Old", newValue: "New" }), look)).toEqual({
      key: "titleChanged",
      from: "Old",
      to: "New",
    });
    expect(activitySentence(row({ field: "title", newValue: "New" }), look)).toEqual({
      key: "titleChanged",
      from: "",
      to: "New",
    });
    expect(activitySentence(row({ field: "title" }), look)).toEqual({ key: "fieldChanged", field: "title" });
  });

  it("priority: both sides through the label lookup; a value outside the enum is the fallback", () => {
    expect(activitySentence(row({ field: "priority", oldValue: "NONE", newValue: "HIGH" }), look)).toEqual({
      key: "priorityChanged",
      from: "prio:NONE",
      to: "prio:HIGH",
    });
    expect(activitySentence(row({ field: "priority", oldValue: "NONE", newValue: "MAXIMUM" }), look)).toEqual({
      key: "fieldChanged",
      field: "priority",
    });
    expect(activitySentence(row({ field: "priority", newValue: "HIGH" }), look)).toEqual({
      key: "fieldChanged",
      field: "priority",
    });
  });

  it("estimate: set, changed and cleared, each minute count through the duration lookup", () => {
    expect(activitySentence(row({ field: "estimate", newValue: "90" }), look)).toEqual({ key: "estimateSet", to: "dur:90" });
    expect(activitySentence(row({ field: "estimate", oldValue: "90", newValue: "120" }), look)).toEqual({
      key: "estimateChanged",
      from: "dur:90",
      to: "dur:120",
    });
    expect(activitySentence(row({ field: "estimate", oldValue: "90" }), look)).toEqual({
      key: "estimateCleared",
      from: "dur:90",
    });
    expect(activitySentence(row({ field: "estimate", oldValue: "0", newValue: "15" }), look)).toEqual({
      key: "estimateChanged",
      from: "dur:0",
      to: "dur:15",
    });
  });

  it("estimate: only decimal digits are minutes — never NaN, an exponent, hex, a sign or padding through the formatter", () => {
    for (const bad of ["2h", "", "1e3", "0x10", " 5 ", "+5", "-5", "1.5", "90m"]) {
      expect(activitySentence(row({ field: "estimate", newValue: bad }), look), bad).toEqual({
        key: "fieldChanged",
        field: "estimate",
      });
    }
    expect(activitySentence(row({ field: "estimate" }), look)).toEqual({ key: "fieldChanged", field: "estimate" });
  });

  it("due date: set, moved and removed, each ISO day through the day lookup", () => {
    expect(activitySentence(row({ field: "targetDate", newValue: "2026-09-15" }), look)).toEqual({
      key: "dueDateSet",
      to: "day:2026-09-15",
    });
    expect(
      activitySentence(row({ field: "targetDate", oldValue: "2026-09-15", newValue: "2026-09-22" }), look),
    ).toEqual({ key: "dueDateChanged", from: "day:2026-09-15", to: "day:2026-09-22" });
    expect(activitySentence(row({ field: "targetDate", oldValue: "2026-09-15" }), look)).toEqual({
      key: "dueDateCleared",
      from: "day:2026-09-15",
    });
  });

  it("due date: only a real calendar day is one — a shape that is not a date never reaches a formatter that throws on it", () => {
    for (const bad of ["15/9", "2026-02-30", "2026-99-99", "0000-00-00", "2026-9-5", "2026-09-15T00:00:00Z"]) {
      expect(activitySentence(row({ field: "targetDate", newValue: bad }), look), bad).toEqual({
        key: "fieldChanged",
        field: "targetDate",
      });
    }
  });

  it("assignee: the REF decides the shape and the resolved name goes through the member lookup — a gone member is still a person", () => {
    expect(activitySentence(row({ field: "assignee", newRef: "m2", newRefName: "Bo" }), look)).toEqual({
      key: "assigned",
      to: "member:Bo",
    });
    expect(
      activitySentence(row({ field: "assignee", oldRef: "m1", oldRefName: "Astrid", newRef: "m2", newRefName: "Bo" }), look),
    ).toEqual({ key: "reassigned", from: "member:Astrid", to: "member:Bo" });
    expect(activitySentence(row({ field: "assignee", oldRef: "m1", oldRefName: "Astrid" }), look)).toEqual({
      key: "unassigned",
      from: "member:Astrid",
    });
    // The ref is set, the name did not resolve: the lookup's "Unknown"
    // word, not "unassigned" and not a hard-coded string.
    expect(activitySentence(row({ field: "assignee", oldRef: "m1", newRef: "gone" }), look)).toEqual({
      key: "reassigned",
      from: "member:?",
      to: "member:?",
    });
    // A name without a ref is not a hand-over: nothing to say.
    expect(activitySentence(row({ field: "assignee", newRefName: "Bo" }), look)).toEqual({
      key: "fieldChanged",
      field: "assignee",
    });
    expect(activitySentence(row({ field: "assignee" }), look)).toEqual({ key: "fieldChanged", field: "assignee" });
  });

  it("state: each ref through the state lookup, and a gone state falls back to the category the row carries", () => {
    expect(
      activitySentence(
        row({ field: "stateCategory", oldValue: "TODO", newValue: "IN_PROGRESS", oldRef: "s-todo", newRef: "s-doing" }),
        look,
      ),
    ).toEqual({ key: "stateChanged", from: "state:To do", to: "state:Doing" });
    expect(
      activitySentence(
        row({ field: "stateCategory", oldValue: "TODO", newValue: "DONE", oldRef: "s-todo", newRef: "s-deleted" }),
        look,
      ),
    ).toEqual({ key: "stateChanged", from: "state:To do", to: "cat:DONE" });
  });

  it("state: a side with neither a ref nor a category is the fallback, whichever side it is", () => {
    expect(activitySentence(row({ field: "stateCategory", newRef: "s-doing" }), look)).toEqual({
      key: "fieldChanged",
      field: "stateCategory",
    });
    expect(activitySentence(row({ field: "stateCategory", oldValue: "TODO", oldRef: "s-todo" }), look)).toEqual({
      key: "fieldChanged",
      field: "stateCategory",
    });
  });

  it("visibility: the new token through the visibility lookup; a third wording is the fallback (§5.5)", () => {
    expect(activitySentence(row({ field: "visibility", oldValue: "INTERNAL", newValue: "CLIENT_VISIBLE" }), look)).toEqual({
      key: "visibilityChanged",
      to: "vis:CLIENT_VISIBLE",
    });
    expect(activitySentence(row({ field: "visibility", newValue: "PUBLIC" }), look)).toEqual({
      key: "fieldChanged",
      field: "visibility",
    });
  });

  it("a field with no sentence yet names itself", () => {
    expect(activitySentence(row({ field: "milestoneId", newRef: "ms-1" }), look)).toEqual({
      key: "fieldChanged",
      field: "milestoneId",
    });
    expect(activitySentence(row({ field: "labelId" }), look)).toEqual({ key: "fieldChanged", field: "labelId" });
  });

  it("comment: the verb in newValue — created, edited, deleted — and a verb this build does not know is the fallback (slice 10)", () => {
    expect(activitySentence(row({ field: "comment", newValue: "created" }), look)).toEqual({ key: "commented" });
    expect(activitySentence(row({ field: "comment", newValue: "edited" }), look)).toEqual({ key: "commentEdited" });
    expect(activitySentence(row({ field: "comment", newValue: "deleted" }), look)).toEqual({ key: "commentDeleted" });
    expect(activitySentence(row({ field: "comment" }), look)).toEqual({ key: "fieldChanged", field: "comment" });
    expect(activitySentence(row({ field: "comment", newValue: "reacted" }), look)).toEqual({
      key: "fieldChanged",
      field: "comment",
    });
  });

  it("commentVisibility: the new token through the visibility lookup; a third wording is the fallback", () => {
    expect(
      activitySentence(row({ field: "commentVisibility", oldValue: "INTERNAL", newValue: "CLIENT_VISIBLE" }), look),
    ).toEqual({ key: "commentVisibilityChanged", to: "vis:CLIENT_VISIBLE" });
    expect(activitySentence(row({ field: "commentVisibility", newValue: "PUBLIC" }), look)).toEqual({
      key: "fieldChanged",
      field: "commentVisibility",
    });
  });
});
