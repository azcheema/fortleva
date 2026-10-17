import { describe, expect, it } from "vitest";

import { ITEM_SURFACES, itemReturnTo, panelSurfaceOf } from "./item-surface";

describe("itemReturnTo — the MFA step-up address for each surface", () => {
  it("builds the exact path for every surface", () => {
    expect(itemReturnTo("backlog", "ACME", 12)).toBe("/projects/ACME/backlog");
    expect(itemReturnTo("board-peek", "ACME", 12)).toBe("/projects/ACME/board?item=ACME-12");
    expect(itemReturnTo("backlog-peek", "ACME", 12)).toBe("/projects/ACME/backlog?item=ACME-12");
    expect(itemReturnTo("tasks-peek", "ACME", 12)).toBe("/tasks?item=ACME-12");
    expect(itemReturnTo("page", "ACME", 12)).toBe("/projects/ACME/items/12");
  });

  it("covers every surface the actions accept — a new one cannot ship without a path", () => {
    for (const surface of ITEM_SURFACES) {
      // Every address is a path of this app, built from the key and the
      // number alone: the project's pages, or the Tasks page's peek.
      expect(itemReturnTo(surface, "ACME", 1)).toMatch(/^\/(projects\/ACME\/|tasks\?item=ACME-1$)/);
    }
    expect(ITEM_SURFACES).toEqual(["backlog", "board-peek", "backlog-peek", "tasks-peek", "page"]);
  });
});

describe("panelSurfaceOf — the panel's prop as an action surface", () => {
  it("maps each of the four panel surfaces, and never to the table's `backlog`", () => {
    expect(panelSurfaceOf("board")).toBe("board-peek");
    expect(panelSurfaceOf("backlog")).toBe("backlog-peek");
    expect(panelSurfaceOf("tasks")).toBe("tasks-peek");
    expect(panelSurfaceOf("page")).toBe("page");
  });
});
