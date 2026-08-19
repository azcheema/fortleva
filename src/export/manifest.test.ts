import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MODEL_CLASSES, tableNameOf } from "@/db/model-registry";

import {
  buildManifest,
  EXPORT_EXCLUDED_COLUMNS,
  EXPORT_MODELS,
  filePathFor,
  serializeRow,
} from "./manifest";

/**
 * The standing rule from Phase 2 on (PLAN.md §8, "platform-continuity
 * cheap win #2"): every tenant-scoped model is in the export census. A
 * model added to MODEL_CLASSES without an export entry fails CI here.
 */

const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
const fieldsOf = (model: string): Set<string> => {
  const pascal = model.charAt(0).toUpperCase() + model.slice(1);
  const m = schema.match(new RegExp(`^model\\s+${pascal}\\s+\\{([\\s\\S]*?)^\\}`, "m"));
  const out = new Set<string>();
  for (const line of (m?.[1] ?? "").split("\n")) {
    const f = line.match(/^\s{2}(\w+)\s+\S+/);
    if (f?.[1]) out.add(f[1]);
  }
  return out;
};

describe("export census covers the model registry", () => {
  const exported = new Set(EXPORT_MODELS.map((m) => m.model));

  it("every MODEL_CLASSES.tenant model has an export entry", () => {
    for (const model of MODEL_CLASSES.tenant) expect(exported.has(model), model).toBe(true);
  });

  it("the tenant root row and the tenant-visible audit rows are exported", () => {
    for (const model of [...MODEL_CLASSES.tenantRoot, ...MODEL_CLASSES.audit]) {
      expect(exported.has(model), model).toBe(true);
    }
  });

  it("no global/auth/catalog model is exported", () => {
    for (const model of MODEL_CLASSES.global) expect(exported.has(model), model).toBe(false);
  });

  it("no export entry names a model outside the registry (no stale entries)", () => {
    const registry = new Set<string>([
      ...MODEL_CLASSES.tenantRoot,
      ...MODEL_CLASSES.tenant,
      ...MODEL_CLASSES.audit,
    ]);
    for (const m of EXPORT_MODELS) expect(registry.has(m.model), m.model).toBe(true);
    expect(EXPORT_MODELS.length).toBe(registry.size);
  });

  it("tables are the physical @@map names and paths are unique", () => {
    const paths = new Set<string>();
    for (const m of EXPORT_MODELS) {
      expect(m.table).toBe(tableNameOf(m.model));
      expect(schema).toContain(`@@map("${m.table}")`);
      paths.add(m.table);
    }
    expect(paths.size).toBe(EXPORT_MODELS.length);
  });
});

describe("excluded columns (encrypted / key material never leave)", () => {
  it("is pinned to the encrypted Tenant bank fields and the wrapped DEK", () => {
    expect(EXPORT_EXCLUDED_COLUMNS).toEqual({
      tenant: ["bankgiro", "plusgiro", "iban", "bic", "databaseUrl"],
      tenantKey: ["wrappedDek"],
    });
  });

  it("every excluded column exists on its model in the schema (a rename must update the list)", () => {
    for (const [model, cols] of Object.entries(EXPORT_EXCLUDED_COLUMNS)) {
      const fields = fieldsOf(model);
      for (const c of cols) expect(fields.has(c), `${model}.${c}`).toBe(true);
    }
  });

  it("serializeRow drops excluded columns and stringifies bigint", () => {
    const line = serializeRow(
      { id: "x", iban: "SE1", storageUsedBytes: 12n, when: new Date("2026-08-17T00:00:00Z") },
      ["iban"],
    );
    expect(JSON.parse(line)).toEqual({
      id: "x",
      storageUsedBytes: "12",
      when: "2026-08-17T00:00:00.000Z",
    });
  });
});

describe("buildManifest", () => {
  it("states the file-bytes mode and totals", () => {
    const m = buildManifest({
      tenantId: "t",
      generatedAt: new Date("2026-08-17T10:00:00Z"),
      models: [],
      files: [
        { fileObjectId: "a", r2Key: "t/a", sha256: "00", sizeBytes: 10 },
        { fileObjectId: "b", r2Key: "t/b", sha256: "11", sizeBytes: 5 },
      ],
      includesFileBytes: false,
    });
    expect(m.schemaVersion).toBe(1);
    expect(m.totalFileBytes).toBe(15);
    expect(m.fileBytesOmittedReason).toBe("over_size_limit");
    const inline = buildManifest({ ...m, generatedAt: new Date(), includesFileBytes: true });
    expect(inline.fileBytesOmittedReason).toBeUndefined();
  });

  it("file paths inside the zip are opaque-id scoped and sanitised", () => {
    // Path separators die, and a leading run of dots cannot survive as
    // a traversal — the entry stays inside its opaque-id directory.
    expect(filePathFor("abc", "../../evil name.pdf")).toBe("files/abc/_.._evil name.pdf");
    expect(filePathFor("abc", null)).toBe("files/abc/abc");
    // Windows-reserved characters and control characters are replaced.
    expect(filePathFor("abc", 'a<b>:c"d|e?f*.pdf')).toBe("files/abc/a_b__c_d_e_f_.pdf");
    expect(filePathFor("abc", "tab\there.txt")).toBe("files/abc/tab_here.txt");
    // Windows strips trailing dots and spaces on extraction — so do we.
    expect(filePathFor("abc", "report. ")).toBe("files/abc/report");
    // A name that sanitises to nothing falls back to the opaque id.
    expect(filePathFor("abc", "..")).toBe("files/abc/abc");
  });

  it("Swedish and other Unicode file names round-trip intact", () => {
    // The continuity archive of a Swedish product must not flatten
    // å/ä/ö (zip has carried UTF-8 entry names via GP bit 11 since
    // 2007; fflate sets it automatically for non-ASCII names).
    expect(filePathFor("abc", "Matte läxa 1.pdf")).toBe("files/abc/Matte läxa 1.pdf");
    expect(filePathFor("abc", "Årsredovisning 2026 – utkast.pdf")).toBe(
      "files/abc/Årsredovisning 2026 – utkast.pdf",
    );
    // Decomposed input (a + U+0308) normalises to the composed form.
    expect(filePathFor("abc", "läxa.txt")).toBe("files/abc/läxa.txt");
  });
});
