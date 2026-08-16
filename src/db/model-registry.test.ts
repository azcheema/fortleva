import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MODEL_CLASSES, RLS_CLASSES, allClassifiedModels, classOf, tableNameOf } from "./model-registry";

/**
 * TENANCY.md §11 model census. Prisma 7 has no runtime DMMF, so the
 * registry is a constant and THIS test is what makes "every tenant-owned
 * row has tenantId" a checked invariant instead of a convention:
 * a new model that isn't classified here fails the build.
 */

type ParsedModel = { name: string; fields: Set<string> };

function parseSchema(): ParsedModel[] {
  const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
  const models: ParsedModel[] = [];
  const re = /^model\s+(\w+)\s+\{([\s\S]*?)^\}/gm;
  for (const match of schema.matchAll(re)) {
    const body = match[2] ?? "";
    const fields = new Set<string>();
    for (const line of body.split("\n")) {
      const fieldMatch = line.match(/^\s{2}(\w+)\s+\S+/);
      if (fieldMatch?.[1]) fields.add(fieldMatch[1]);
    }
    models.push({ name: match[1] ?? "", fields });
  }
  return models;
}

const camel = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

describe("model census (TENANCY.md §11)", () => {
  const parsed = parseSchema();

  it("parses a sane number of models", () => {
    expect(parsed.length).toBeGreaterThanOrEqual(20);
  });

  it("every schema model is classified — unclassified models fail the build", () => {
    const classified = new Set(allClassifiedModels());
    const missing = parsed.map((m) => camel(m.name)).filter((n) => !classified.has(n));
    expect(missing, `Classify these models in model-registry.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("every classified model exists in the schema — no stale registry entries", () => {
    const inSchema = new Set(parsed.map((m) => camel(m.name)));
    const stale = allClassifiedModels().filter((n) => !inSchema.has(n));
    expect(stale).toEqual([]);
  });

  it("every tenant-scoped model physically carries tenantId", () => {
    for (const name of MODEL_CLASSES.tenant) {
      const model = parsed.find((m) => camel(m.name) === name);
      expect(model?.fields.has("tenantId"), `${name} must carry tenantId`).toBe(true);
    }
  });

  it("no global model carries tenantId — misfiled models fail", () => {
    for (const name of MODEL_CLASSES.global) {
      const model = parsed.find((m) => camel(m.name) === name);
      expect(model?.fields.has("tenantId"), `${name} is filed global but has tenantId`).toBe(false);
    }
  });

  it("every tenant-scoped model is in exactly one RLS subclass", () => {
    const seen = new Map<string, string[]>();
    for (const [cls, models] of Object.entries(RLS_CLASSES)) {
      for (const m of models) seen.set(m, [...(seen.get(m) ?? []), cls]);
    }
    for (const name of MODEL_CLASSES.tenant) {
      expect(seen.get(name), `${name} must be in exactly one RLS_CLASSES entry`).toHaveLength(1);
    }
    const strays = [...seen.keys()].filter(
      (m) => !(MODEL_CLASSES.tenant as readonly string[]).includes(m),
    );
    expect(strays, "RLS_CLASSES lists non-tenant-scoped models").toEqual([]);
  });

  it("tableNameOf matches every model's @@map", () => {
    const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
    for (const match of schema.matchAll(/^model\s+(\w+)\s+\{([\s\S]*?)^\}/gm)) {
      const mapped = match[2]?.match(/@@map\("(\w+)"\)/)?.[1];
      expect(tableNameOf(camel(match[1] ?? "")), match[1]).toBe(mapped);
    }
  });

  it("classOf resolves both spellings", () => {
    expect(classOf("member")).toBe("tenant");
    expect(classOf("Member")).toBe("tenant");
    expect(classOf("tenant")).toBe("tenantRoot");
    expect(classOf("auditEvent")).toBe("audit");
    expect(classOf("user")).toBe("global");
    expect(classOf("nonexistent")).toBeUndefined();
  });
});
