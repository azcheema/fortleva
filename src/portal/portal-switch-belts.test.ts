import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * THE PORTAL SWITCH'S BY-ID BELTS, PINNED STRUCTURALLY (Phase 3 slice 74,
 * OPEN_QUESTIONS C40).
 *
 * A child row's `portal_enabled` is a COPY of its project's switch, and
 * until slice 74 a row written while a DISABLE was in flight kept `true`
 * after the portal was off. The gate migration (20260928180000) closed
 * that race in the database. The slice ALSO made every portal read that
 * resolves a row BY ID restate the switch from the project itself —
 * `project: { portalEnabled: true }` — so those reads stop depending on
 * the copy at all:
 *
 *   · `authorizePortal`'s work_item, document and project_version probes
 *     (src/portal/authorize.ts) — under the contact principal, where the
 *     relation filter is a read of `project` that project's own
 *     `portal_gate` answers;
 *   · `setPortalTaskDone`'s re-read (src/modules/work/portal-writes.ts)
 *     and `documentGate` (src/documents/portal-writes.ts) — under the
 *     SYSTEM principal, where no policy answers and the term written out
 *     is the only thing that does.
 *
 * NO DATABASE TEST CAN SEE THEM GO. After the fix a stale-TRUE row cannot
 * be manufactured — a direct write is re-stamped, and the test roles
 * cannot disable triggers — so a refactor that dropped one of these terms
 * would leave every dbtest green. This file is the pin.
 *
 * IT READS THE AST, never the text, for the reason brokered-writes.test.ts
 * records: this codebase's comments quote the identifiers they explain,
 * and each of these sites has a comment that spells
 * `project: { portalEnabled: true }` out.
 *
 * WHAT COUNTS: the `where` of the call (or the gate's object) must carry
 * `project: { …, portalEnabled: true }` — or Prisma's `project: { is: { …
 * } }` — directly, inside an `AND`, or inside an `OR` whose EVERY branch
 * either carries it or is exactly `{ projectId: null }` (a client-level
 * document, which has no project and no switch). Only object and array
 * LITERALS are followed: a term moved behind a spread or a helper stops
 * counting, on purpose — that move is one a reviewer should see this file
 * fail on and update. A key followed by a SPREAD that could set it does
 * not count either (only a literal spread without the key is known not
 * to). The one helper that is followed is
 * `documentGate` itself — a document read may SPREAD it instead of
 * restating the term, provided nothing after the spread (a later `OR`,
 * `AND`, `project`, `portalEnabled` or another spread) can override it.
 *
 * MUTATIONS CHECKED BY REASONING against the predicate below, each of
 * which fails it: deleting `portalEnabled: true` from any of the five
 * (`switchOn` finds no such property); writing `portalEnabled: false` or a
 * variable (`isTrue` requires the literal `true`); deleting the `project`
 * term, or the whole `OR`, from a where (`carries` finds nothing);
 * adding an OR branch that admits project rows without the switch, e.g.
 * `{ projectId: { not: null } }` (the every-branch rule); and deleting a
 * probe, or renaming its delegate or function (the per-site count below
 * finds zero, so nothing passes vacuously); a spread after the term
 * (`prop` refuses a key a later spread could override); and, for the
 * document reads, dropping `...documentGate(…)` from the by-id download or
 * overriding it with a later `OR` (`gated`). The predicate's own case at
 * the bottom runs those mutations on literal filters.
 */

const SRC = join(__dirname, "..");

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(join(SRC, file), "utf8"), ts.ScriptTarget.ES2022, true);

const visit = (node: ts.Node, fn: (n: ts.Node) => void): void => {
  fn(node);
  node.forEachChild((child) => visit(child, fn));
};

/** Parentheses, `as const`, `satisfies` and `<T>` casts are not part of a filter's meaning. */
const unwrap = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (
    ts.isParenthesizedExpression(x) ||
    ts.isAsExpression(x) ||
    ts.isSatisfiesExpression(x) ||
    ts.isTypeAssertionExpression(x)
  ) {
    x = x.expression;
  }
  return x;
};

const keyOf = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;

/**
 * A literal object's own `name: value` — never a spread, never a
 * shorthand, and never one a LATER spread could override (`{ project: …,
 * ...other }` does not say what `project` ends up as).
 */
const prop = (obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
  const at = obj.properties.findIndex((p) => ts.isPropertyAssignment(p) && keyOf(p.name) === name);
  if (at === -1) return undefined;
  if (obj.properties.slice(at + 1).some((p) => ts.isSpreadAssignment(p) && mayCarry(p.expression, name))) {
    return undefined;
  }
  const found = obj.properties[at];
  return found && ts.isPropertyAssignment(found) ? found.initializer : undefined;
};

/**
 * Could spreading this expression set `name`? Only literals can be read:
 * an object literal without the key (and without spreads of its own) and
 * a conditional between two such cannot — `...(opts.take ? { take } : {})`
 * is the shape the file broker uses. Anything else might.
 */
function mayCarry(e: ts.Expression, name: string): boolean {
  const x = unwrap(e);
  if (ts.isConditionalExpression(x)) return mayCarry(x.whenTrue, name) || mayCarry(x.whenFalse, name);
  if (!ts.isObjectLiteralExpression(x)) return true;
  return x.properties.some((p) => {
    if (ts.isSpreadAssignment(p)) return true;
    const key = keyOf(p.name);
    return key === undefined || key === name;
  });
}

const isTrue = (e: ts.Expression | undefined): boolean =>
  e !== undefined && unwrap(e).kind === ts.SyntaxKind.TrueKeyword;
const isNull = (e: ts.Expression | undefined): boolean =>
  e !== undefined && unwrap(e).kind === ts.SyntaxKind.NullKeyword;

/** A relation filter on `project` that requires the switch ON: `{ portalEnabled: true }`, or `{ is: { … } }`. */
const switchOn = (e: ts.Expression): boolean => {
  const o = unwrap(e);
  if (!ts.isObjectLiteralExpression(o)) return false;
  if (isTrue(prop(o, "portalEnabled"))) return true;
  const is = prop(o, "is");
  return is !== undefined && switchOn(is);
};

/** `{ projectId: null }` and nothing else — a row with no project. */
const projectless = (e: ts.Expression): boolean => {
  const o = unwrap(e);
  return ts.isObjectLiteralExpression(o) && o.properties.length === 1 && isNull(prop(o, "projectId"));
};

/** Does this where-filter require the PROJECT's switch on every row it can return? */
const carries = (filter: ts.Expression): boolean => {
  const o = unwrap(filter);
  if (!ts.isObjectLiteralExpression(o)) return false;
  const project = prop(o, "project");
  if (project !== undefined && switchOn(project)) return true;
  const and = prop(o, "AND");
  if (and !== undefined) {
    const list = unwrap(and);
    if (ts.isArrayLiteralExpression(list) && list.elements.some(carries)) return true;
    if (ts.isObjectLiteralExpression(list) && carries(list)) return true;
  }
  const or = prop(o, "OR");
  if (or !== undefined) {
    const list = unwrap(or);
    if (
      ts.isArrayLiteralExpression(list) &&
      list.elements.some(carries) &&
      list.elements.every((b) => carries(b) || projectless(b))
    ) {
      return true;
    }
  }
  return false;
};

/** `documentGate(…)` itself — the one helper this pin follows. */
const isGateCall = (e: ts.Expression): boolean => {
  const x = unwrap(e);
  return ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === "documentGate";
};

/** Keys that could undo the gate if written after its spread. */
const OVERRIDES = new Set(["OR", "AND", "NOT", "project", "projectId", "portalEnabled"]);

/**
 * A document filter that SPREADS `documentGate(…)` with nothing after it
 * that could override the gate's terms: no later spread, and none of
 * `OVERRIDES` written after it (nor any key this pin cannot name).
 */
const gated = (filter: ts.Expression): boolean => {
  const o = unwrap(filter);
  if (!ts.isObjectLiteralExpression(o)) return false;
  const at = o.properties.findIndex((p) => ts.isSpreadAssignment(p) && isGateCall(p.expression));
  if (at === -1) return false;
  return o.properties.slice(at + 1).every((p) => {
    if (ts.isSpreadAssignment(p) || p.name === undefined) return false;
    const name = keyOf(p.name);
    return name !== undefined && !OVERRIDES.has(name);
  });
};

/** The body of a top-level `function name(...)`. */
const functionBody = (source: ts.SourceFile, name: string): ts.Block | undefined => {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) {
      return statement.body;
    }
  }
  return undefined;
};

/** The `where` of every `<anything>.<delegate>.<method>({ where: … })` inside `body`. */
const callWheres = (body: ts.Node, delegate: string, method = "findFirst"): ts.Expression[] => {
  const out: ts.Expression[] = [];
  visit(body, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== method) return;
    const target = callee.expression;
    if (!ts.isPropertyAccessExpression(target) || target.name.text !== delegate) return;
    const arg = node.arguments[0] && unwrap(node.arguments[0]);
    const where = arg && ts.isObjectLiteralExpression(arg) ? prop(arg, "where") : undefined;
    // A call whose where is not a literal is still COUNTED — as a site
    // that fails — so it cannot slip out of the pin by being indirect.
    out.push(where ?? node);
  });
  return out;
};

describe("the portal switch's by-id belts (slice 74, C40)", () => {
  it("authorizePortal's work_item, document and project_version probes read the switch from the project", () => {
    const body = functionBody(parse(join("portal", "authorize.ts")), "authorizePortal");
    expect(body, "authorizePortal is found").toBeDefined();
    for (const delegate of ["workItem", "document", "projectVersion"]) {
      const wheres = callWheres(body!, delegate);
      expect(wheres.length, `authorizePortal probes ${delegate} by id`).toBeGreaterThan(0);
      for (const where of wheres) {
        expect(carries(where), `authorizePortal's ${delegate} probe carries project: { portalEnabled: true }`).toBe(true);
      }
    }
  });

  it("setPortalTaskDone's system re-read of the task reads the switch from the project", () => {
    const body = functionBody(parse(join("modules", "work", "portal-writes.ts")), "setPortalTaskDone");
    expect(body, "setPortalTaskDone is found").toBeDefined();
    const wheres = callWheres(body!, "workItem");
    expect(wheres.length, "setPortalTaskDone re-reads the task").toBeGreaterThan(0);
    for (const where of wheres) {
      expect(carries(where), "setPortalTaskDone's re-read carries project: { portalEnabled: true }").toBe(true);
    }
  });

  it("documentGate reads the switch from the project for every project file, and is used", () => {
    const source = parse(join("documents", "portal-writes.ts"));
    let gate: ts.Expression | undefined;
    let calls = 0;
    visit(source, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "documentGate") {
        const init = node.initializer && unwrap(node.initializer);
        if (init && ts.isArrowFunction(init) && !ts.isBlock(init.body)) gate = init.body;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "documentGate") {
        calls++;
      }
    });
    expect(gate, "documentGate is an arrow returning its filter").toBeDefined();
    expect(carries(gate!), "documentGate carries project: { portalEnabled: true } (or no project at all)").toBe(true);
    // A belt nobody buckles is not one: the downloads and file lists spread it.
    expect(calls, "documentGate is applied").toBeGreaterThan(0);
  });

  it("every document read of the file broker applies it — the by-id download above all — and nothing overrides it", () => {
    const source = parse(join("documents", "portal-writes.ts"));
    // THE BY-ID SITE: the download resolves ONE document by the id a
    // contact sent. Its gate is the belt this slice is about.
    const byId = callWheres(source, "document", "findFirst");
    expect(byId.length, "the download resolves its document by id").toBeGreaterThan(0);
    for (const where of byId) {
      expect(carries(where) || gated(where), "the by-id download applies documentGate, unoverridden").toBe(true);
    }
    for (const where of callWheres(source, "document", "findMany")) {
      expect(carries(where) || gated(where), "a document list applies documentGate, unoverridden").toBe(true);
    }
    // Versions reach their document through the relation filter.
    for (const where of callWheres(source, "fileVersion", "findMany")) {
      const o = unwrap(where);
      const document = ts.isObjectLiteralExpression(o) ? prop(o, "document") : undefined;
      expect(
        document !== undefined && (isGateCall(document) || carries(document) || gated(document)),
        "a version read filters its document through documentGate",
      ).toBe(true);
    }
  });

  it("the predicate itself: it passes the belt, and fails each way the belt can be broken", () => {
    // The pin above is only as good as `carries`, so its mutations are
    // measured here on literal filters rather than trusted to the prose.
    const filter = (code: string): ts.Expression => {
      const source = ts.createSourceFile("f.ts", `const f = (${code});`, ts.ScriptTarget.ES2022, true);
      const decl = (source.statements[0] as ts.VariableStatement).declarationList.declarations[0]!;
      return decl.initializer!;
    };
    expect(carries(filter(`{ id, project: { portalEnabled: true } }`))).toBe(true);
    expect(carries(filter(`{ id, project: { archivedAt: null, portalEnabled: true } }`))).toBe(true);
    expect(carries(filter(`{ id, project: { is: { portalEnabled: true } } }`))).toBe(true);
    expect(carries(filter(`{ id, OR: [{ projectId: null }, { project: { portalEnabled: true } }] }`))).toBe(true);
    expect(carries(filter(`{ id, AND: [{ deletedAt: null }, { project: { portalEnabled: true } }] }`))).toBe(true);

    expect(carries(filter(`{ id }`)), "no term").toBe(false);
    expect(carries(filter(`{ id, project: { archivedAt: null } }`)), "the switch dropped").toBe(false);
    expect(carries(filter(`{ id, project: { portalEnabled: false } }`)), "the switch inverted").toBe(false);
    expect(carries(filter(`{ id, project: { portalEnabled: on } }`)), "not a literal").toBe(false);
    expect(carries(filter(`{ id, portalEnabled: true }`)), "the row's COPY is not the project's switch").toBe(false);
    expect(carries(filter(`{ id, OR: [{ projectId: null }, { project: { archivedAt: null } }] }`)), "OR without it").toBe(false);
    expect(
      carries(filter(`{ id, OR: [{ projectId: { not: null } }, { project: { portalEnabled: true } }] }`)),
      "an OR branch that admits project rows without it",
    ).toBe(false);
    expect(carries(filter(`{ id, ...belt }`)), "behind a spread").toBe(false);
    expect(
      carries(filter(`{ id, project: { portalEnabled: true }, ...other }`)),
      "a spread after it may override it",
    ).toBe(false);
    expect(
      carries(filter(`{ id, project: { portalEnabled: true }, ...(take ? { take } : {}) }`)),
      "a literal spread that cannot set the key",
    ).toBe(true);
    expect(
      carries(filter(`{ id, project: { portalEnabled: true }, ...(loose ? { project: {} } : {}) }`)),
      "a literal spread that can",
    ).toBe(false);

    expect(gated(filter(`{ id: documentId, ...documentGate(principal) }`)), "the download's shape").toBe(true);
    expect(gated(filter(`{ id, ...documentGate(principal), take: 1 }`)), "an unrelated key after it").toBe(true);
    expect(gated(filter(`{ id }`)), "the gate dropped").toBe(false);
    expect(gated(filter(`{ id, ...notTheGate(principal) }`)), "another helper").toBe(false);
    expect(
      gated(filter(`{ id, ...documentGate(principal), OR: [{ projectId: null }, { project: { archivedAt: null } }] }`)),
      "the gate's OR overridden after the spread",
    ).toBe(false);
    expect(gated(filter(`{ id, ...documentGate(principal), portalEnabled: undefined }`)), "a term overridden").toBe(false);
    expect(gated(filter(`{ id, ...documentGate(principal), ...other }`)), "a later spread").toBe(false);
  });
});
