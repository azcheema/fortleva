import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * THE UNGUARDED HALVES OF A PUBLISH (slice 135's security review, NIT).
 * `preparePublish` and `freezePublish` (`updates.ts`) authorise nothing —
 * they freeze numbers into a post and write it, in the name of whatever
 * `publisherMemberId` they are handed — and `privateNamesIn` reads a
 * project's private titles under whatever transaction it is given. Each
 * caller does the checks: the member's `publishUpdate` (requireAccess, scope,
 * the compare-and-set) and the job's `publishScheduledUpdates` (the
 * scheduler, resolved AS THEM, twice). This pins who may IMPORT them, by the
 * import declarations themselves (an AST read, never a text search — a
 * comment naming them must not fail it: `brokered-writes.test.ts`'s lesson).
 * A new caller is a design decision: add it here, with its own checks.
 */

const SRC = join(__dirname, "..", "..");
const HALVES = new Set(["preparePublish", "freezePublish", "privateNamesIn"]);
const ALLOWED = ["modules/work/scheduled-updates.ts"];

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "generated" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.(test|dbtest)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
};

const UPDATES = join(SRC, "modules", "work", "updates");

/** Whether a module specifier, read from `file`, names the file the halves live in. */
function isUpdatesModule(file: string, spec: ts.Expression | undefined): boolean {
  if (spec === undefined || !ts.isStringLiteral(spec)) return false;
  const text = spec.text.replace(/\.(tsx?|js)$/, "");
  const target = text.startsWith("@/") ? join(SRC, text.slice(2)) : text.startsWith(".") ? resolve(dirname(file), text) : null;
  return target !== null && resolve(target) === resolve(UPDATES);
}

/** The halves a file imports by name (named imports and re-exports alike), or the whole module at once. */
function halvesImported(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  for (const node of source.statements) {
    // `import * as u from "./updates"` and `export * from "./updates"` reach
    // every half without naming one (the re-check's NIT).
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings &&
      ts.isNamespaceImport(node.importClause.namedBindings) &&
      isUpdatesModule(file, node.moduleSpecifier)
    ) {
      found.push("*");
    }
    if (
      ts.isExportDeclaration(node) &&
      (!node.exportClause || ts.isNamespaceExport(node.exportClause)) &&
      isUpdatesModule(file, node.moduleSpecifier)
    ) {
      found.push("*");
    }
    const clause =
      ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        ? node.importClause.namedBindings.elements
        : ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements
          : [];
    for (const el of clause) {
      const name = (el.propertyName ?? el.name).text;
      if (HALVES.has(name)) found.push(name);
    }
  }
  return found;
}

describe("the unguarded halves of a publish", () => {
  it("are imported only by the scheduled-updates job's module (updates.ts calls them itself)", () => {
    const importers = walk(SRC)
      .filter((f) => halvesImported(f).length > 0)
      .map((f) => relative(SRC, f).replaceAll("\\", "/"))
      .sort();
    expect(importers).toEqual(ALLOWED);
  });
});
