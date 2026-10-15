import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LABEL_COLORS, isLabelColor, labelColorStyle } from "./label-colors";

describe("label colours", () => {
  it("are exactly the list the database's CHECK holds — the two cannot drift", () => {
    // The migration review's LOW: the list is written twice, in the CHECK
    // and here, and the two drifted once while the slice was being written.
    const sql = readFileSync(join(process.cwd(), "prisma/migrations/20261027090000_stages_labels/migration.sql"), "utf8");
    const check = /ADD CONSTRAINT label_color_token\s+CHECK \(color IS NULL OR color IN \(([^)]*)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    const inSql = check![1]!.split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(inSql).toEqual([...LABEL_COLORS]);
  });

  it("draw a dot from an identity hue, and nothing for no colour or an unknown value", () => {
    expect(labelColorStyle("teal")).toEqual({ "--entity": "var(--entity-5)" });
    expect(labelColorStyle(null)).toBeNull();
    expect(labelColorStyle("#ff0000")).toBeNull();
    expect(isLabelColor("toString")).toBe(false); // own keys only
  });
});
