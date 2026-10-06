import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * EVERY CONTACT ATTRIBUTION COLUMN IS COUNTED BEFORE A CONTACT IS DELETED
 * (slice 96, 2026-10-06).
 *
 * A `Contact` is hard-deleted, and what they wrote carries only an id with
 * no foreign key — "attribution, no FK", the schema's own words. The
 * founder's rule (2026-09-23): keep the name, refuse the delete — so
 * `deleteContact` (src/clients/service.ts) counts every such column and
 * refuses a contact who has written anything. Slice 79 found the sign-off's
 * column missing from that list; slice 93 then added three more (a sealed
 * ask's asker, confirmer and withdrawer) and none was counted, which slice
 * 96 found while adding its own. A list kept by hand drifts, so this test
 * reads the schema: every `…ContactId` field whose comment says
 * "attribution, no FK" must appear in `deleteContact` as a count of that
 * model by that field.
 *
 * Mutation-checked by reasoning: deleting any one count line, renaming its
 * field, or pointing it at another model leaves its pair unmatched; a new
 * attribution column with no count fails the same way. The floor below
 * stops a schema rename from turning the walk into a loop over nothing.
 */

const ROOT = join(__dirname, "..", "..");
const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
const service = readFileSync(join(ROOT, "src", "clients", "service.ts"), "utf8");

/** `[model delegate, field]` for every contact attribution column in the schema. */
const attributionColumns = (): [string, string][] => {
  const out: [string, string][] = [];
  let model: string | null = null;
  for (const line of schema.split("\n")) {
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) {
      model = open[1]!;
      continue;
    }
    if (/^\}/.test(line)) {
      model = null;
      continue;
    }
    const field = /^\s+(\w+ContactId)\s+String\??\b.*\/\/.*attribution, no FK/.exec(line);
    if (model && field) out.push([model.charAt(0).toLowerCase() + model.slice(1), field[1]!]);
  }
  return out;
};

/** The body of `deleteContact`, so a count elsewhere in the file does not satisfy the pin. */
const deleteContactBody = (): string => {
  const start = service.indexOf("export async function deleteContact(");
  expect(start).toBeGreaterThan(-1);
  const next = service.indexOf("\nexport ", start + 1);
  return service.slice(start, next === -1 ? undefined : next);
};

describe("contact attribution columns", () => {
  it("the schema walk finds them all (a floor, so it cannot pass vacuously)", () => {
    const columns = attributionColumns();
    // Eight by slice 79, three by slice 93, one by slice 96.
    expect(columns.length).toBeGreaterThanOrEqual(12);
    expect(columns).toContainEqual(["credentialItem", "submittedByContactId"]);
    expect(columns).toContainEqual(["sealedOpenRequest", "askedByContactId"]);
  });

  it("deleteContact counts every one of them before it deletes", () => {
    const body = deleteContactBody();
    const missing = attributionColumns().filter(([delegate, field]) => {
      const count = new RegExp(
        `tx\\.${delegate}\\.count\\(\\s*\\{\\s*where:\\s*\\{\\s*tenantId:\\s*ctx\\.tenantId,\\s*${field}:\\s*contactId\\s*\\},?\\s*\\},?\\s*\\)`,
      );
      return !count.test(body);
    });
    expect(missing).toEqual([]);
  });
});
