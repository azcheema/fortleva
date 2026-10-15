import { describe, expect, it } from "vitest";

import { readTrelloBoard } from "./trello";

const board = {
  id: "B",
  name: "Board",
  lists: [
    { id: "L2", name: "Done", closed: false, pos: 2000 },
    { id: "L1", name: "To do", closed: false, pos: 1000 },
    { id: "L3", name: "Old", closed: true, pos: 3000 },
  ],
  labels: [
    { id: "lb1", name: "Bug" },
    { id: "lb2", name: "" },
    { id: "lb3", name: "bug" },
  ],
  members: [{ id: "T1", fullName: "Anna Bergström", username: "anna" }, { id: "T2", fullName: null, username: "bo" }],
  checklists: [
    { id: "ch2", idCard: "c1", name: "Launch", pos: 2, checkItems: [{ name: "Go", state: "incomplete", pos: 1 }] },
    {
      id: "ch1",
      idCard: "c1",
      name: "Checklist",
      pos: 1,
      checkItems: [
        { name: "B", state: "complete", pos: 2 },
        { name: "A", state: "incomplete", pos: 1 },
        { name: "  ", state: "incomplete", pos: 3 },
      ],
    },
  ],
  cards: [
    { id: "c3", name: "Second in to do", idList: "L1", pos: 2, closed: false },
    { id: "c1", name: "First in to do", desc: "Body", idList: "L1", pos: 1, idMembers: ["T1", "T2"], idLabels: ["lb1", "lb2", "lb3"], due: "2026-10-19T23:30:00.000Z", shortUrl: "https://trello.com/c/AbCd" },
    { id: "c2", name: "In done", idList: "L2", pos: 1, shortUrl: "javascript:alert(1)" },
    { id: "c4", name: "Archived", idList: "L1", pos: 3, closed: true },
    { id: "c5", name: "In an archived list", idList: "L3", pos: 1 },
  ],
  actions: [{ type: "commentCard", data: { text: "left behind" } }],
};

describe("readTrelloBoard", () => {
  it("returns open lists and cards in board order, counting what is left out", () => {
    const read = readTrelloBoard(board, "Europe/Stockholm")!;
    expect(read.lists).toEqual([
      { id: "L1", name: "To do" },
      { id: "L2", name: "Done" },
    ]);
    expect(read.cards.map((c) => c.id)).toEqual(["c1", "c3", "c2"]);
    expect(read.archivedCards).toBe(2);
  });

  it("keeps the first member, named labels once, checklists in order, and a trello.com link only", () => {
    const [c1, , c2] = readTrelloBoard(board, "Europe/Stockholm")!.cards;
    expect(c1).toMatchObject({ memberId: "T1", labels: ["Bug"], link: "https://trello.com/c/AbCd", desc: "Body" });
    expect(c1!.checklists).toEqual([
      // The default "Checklist" name says nothing and is dropped; blank items go.
      { name: null, items: [{ text: "A", done: false }, { text: "B", done: true }] },
      { name: "Launch", items: [{ text: "Go", done: false }] },
    ]);
    expect(c2!.link).toBeNull();
  });

  it("reads a due instant as a day in the workspace's zone", () => {
    // 23:30 UTC on the 19th is 01:30 on the 20th in Stockholm.
    expect(readTrelloBoard(board, "Europe/Stockholm")!.cards[0]!.due).toBe("2026-10-20");
    expect(readTrelloBoard(board, "UTC")!.cards[0]!.due).toBe("2026-10-19");
  });

  it("names a member with no full name by their username", () => {
    expect(readTrelloBoard(board, "UTC")!.members).toEqual([
      { id: "T1", name: "Anna Bergström" },
      { id: "T2", name: "bo" },
    ]);
  });

  it("drops a due date and a link the server would refuse, so one card never refuses its batch", () => {
    const odd = {
      lists: [{ id: "L", name: "To do", pos: 1 }],
      cards: [
        { id: "far", name: "Far", idList: "L", pos: 1, due: "2202-01-01T12:00:00.000Z", shortUrl: `https://trello.com/c/${"x".repeat(400)}` },
        { id: "cred", name: "Cred", idList: "L", pos: 2, shortUrl: "https://user:pw@trello.com/c/abc" },
      ],
    };
    const [far, cred] = readTrelloBoard(odd, "Europe/Stockholm")!.cards;
    expect(far).toMatchObject({ due: null, link: null });
    expect(cred!.link).toBeNull();
  });

  it("is null for JSON that is not a board export", () => {
    expect(readTrelloBoard({ hello: "world" }, "UTC")).toBeNull();
    expect(readTrelloBoard([1, 2], "UTC")).toBeNull();
  });
});
