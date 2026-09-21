import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * THE BROKERED-WRITE SHAPE, PINNED STRUCTURALLY (Phase 3 slice 6a).
 *
 * `portal-projections.test.ts` guards what LEAVES the building through a
 * portal read. Nothing guarded what a portal WRITE looks like, and the
 * four ways it can go wrong are all ways somebody writes while meaning
 * well:
 *
 *  1. **Authorizing after opening the system transaction**, or not at
 *     all. `authorizePortal()` refuses a system handle outright (step 0),
 *     so the wrong order cannot silently pass — it throws — but it
 *     throws at RUNTIME, on a path that needs a contact session to
 *     reach. An ordering pin fails at `pnpm test`.
 *  2. **Using a principal other than `system` for the write.** A contact
 *     principal would be refused by RLS; a MEMBER principal would not be,
 *     and would write the row as whichever member happened to be around.
 *  3. **Reaching for `runAction`** in a portal server action, because it
 *     is the shape already on the clipboard from the member app — which
 *     would hand a client the difference between FORBIDDEN, NOT_FOUND
 *     and NOT_ENTITLED, the exact disclosure `src/portal/action.ts`
 *     exists to prevent.
 *  4. **Taking an identity out of the form.** On this plane that is not
 *     only the member plane's standing rule: it is also the one door
 *     through which a member inside View-as could write rows attributed
 *     to the client they are looking through.
 *
 * AN ORDERING ASSERTION ON THE FUNCTION'S OWN BODY, never a proximity
 * regex over the file — the correction slice 48 had to make twice. A
 * whole-file `indexOf` is satisfied by the import at the top, so
 * deleting the call would leave the pin green; the body is sliced out of
 * the AST here, so a deletion fails at the first attempt.
 *
 * AND EVERY OTHER ASSERTION READS THE AST RATHER THAN THE TEXT, which
 * the first cut of this file proved necessary in one run: a
 * `withTenant(tenantId, {type:'system'})` written inside a DOCBLOCK
 * matched the regex and failed the pin for quoting the rule it enforces,
 * and a paragraph saying "`runPortalForm` rather than `runForm`" was
 * reported as reaching for `runForm`. That is the lesson this repo has
 * already paid for twice (`portal-projections.test.ts`, on the word
 * `cost`, slice 46): a test that goes red for the wrong reason teaches
 * people to ignore it.
 */

const SRC = join(__dirname, "..");
const PORTAL_ROUTES = join("app", "(portal)");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "generated" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
};

const isTest = (file: string): boolean => /\.(test|dbtest)\.tsx?$/.test(file);

/** Every brokered-write module in the product, by the conventional name. */
const brokerFiles = (): string[] =>
  walk(SRC).filter((f) => f.endsWith("portal-writes.ts") && !isTest(f));

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);

const visit = (node: ts.Node, fn: (n: ts.Node) => void): void => {
  fn(node);
  node.forEachChild((child) => visit(child, fn));
};

/** The principal argument of every `withTenant(...)` CALL in a file. */
const withTenantPrincipals = (source: ts.SourceFile): ts.Expression[] => {
  const out: ts.Expression[] = [];
  visit(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "withTenant"
    ) {
      const principal = node.arguments[1];
      if (principal) out.push(principal);
    }
  });
  return out;
};

/** Does any real identifier in this file carry this name? (Comments do not.) */
const namesIdentifier = (source: ts.SourceFile, name: string): boolean => {
  let found = false;
  visit(source, (node) => {
    if (ts.isIdentifier(node) && node.text === name) found = true;
  });
  return found;
};

/** The named bindings a file imports from one module specifier. */
const importedFrom = (source: ts.SourceFile, specifier: string): string[] => {
  const out: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== specifier) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) out.push(element.name.text);
    }
  }
  return out;
};

/** One top-level function declaration's body, as a NODE. */
const bodyOf = (file: string, name: string): ts.Block => {
  const source = parse(file);
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) {
      return statement.body;
    }
  }
  throw new Error(`no function declaration named ${name} in ${file}`);
};

/**
 * WHERE A CALL TO `name(...)` STARTS INSIDE A BODY, by AST position and
 * never by `indexOf` over the body's TEXT.
 *
 * The distinction is the one a code review caught in the first cut of
 * this file, and it is sharp: `node.getText()` INCLUDES COMMENTS, so an
 * ordering pin built on string offsets is satisfied by a call that has
 * been deleted as long as a comment above the deletion still spells the
 * name — and this codebase's comments are dense and routinely quote the
 * identifiers they explain. That is the same failure as slice 48's
 * whole-file `indexOf`, one level in.
 */
const callPosition = (body: ts.Block, name: string): number => {
  let found = -1;
  visit(body, (node) => {
    if (found !== -1) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const text = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (text === name) found = node.getStart();
    }
  });
  return found;
};

/** Does any `record(...)` call in this body pass this property? */
const recordPasses = (body: ts.Block, property: string): boolean => {
  let passes = false;
  visit(body, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isIdentifier(node.expression) || node.expression.text !== "record") return;
    for (const arg of node.arguments) {
      if (!ts.isObjectLiteralExpression(arg)) continue;
      for (const prop of arg.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === property) {
          passes = true;
        }
      }
    }
  });
  return passes;
};

const WORK_BROKER = join(SRC, "modules", "work", "portal-writes.ts");

describe("brokered portal writes", () => {
  it("there is at least one broker, so nothing below passes vacuously", () => {
    // The control. Renaming the convention would otherwise turn every
    // assertion in this file into a loop over an empty list.
    expect(brokerFiles().map((f) => relative(SRC, f))).toContain(relative(SRC, WORK_BROKER));
  });

  it("every write runs as `system` and under no other principal", () => {
    for (const file of brokerFiles()) {
      const source = parse(file);
      const principals = withTenantPrincipals(source);
      expect(principals.length, relative(SRC, file)).toBeGreaterThan(0);
      for (const principal of principals) {
        // The literal must be INLINE: a variable here would be a
        // principal chosen somewhere this test cannot see. Quotes are
        // stripped so Prettier's choice of quote style is not a pin.
        expect(ts.isObjectLiteralExpression(principal), relative(SRC, file)).toBe(true);
        expect(principal.getText(source).replace(/\s|"|'/g, ""), relative(SRC, file)).toBe(
          "{type:system}",
        );
      }
    }
  });

  it("authorization happens before the system transaction opens", () => {
    const body = bodyOf(WORK_BROKER, "createPortalRequest");
    const authorize = callPosition(body, "authorizePortal");
    const read = callPosition(body, "withPortalRead");
    const write = callPosition(body, "withTenant");
    expect(read).toBeGreaterThan(-1);
    expect(authorize).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(read).toBeLessThan(write);
    expect(authorize).toBeLessThan(write);
  });

  it("the audit row names the contact, inside the write's own transaction", () => {
    const body = bodyOf(WORK_BROKER, "createPortalRequest");
    // THE PROPERTY IS PASSED, not merely mentioned. Deleting
    // `brokeredForContactId: principal.contactId` while leaving the
    // comment above it — which names the field — would have left the
    // first cut of this pin green while every portal audit row silently
    // became SYSTEM with a null actor, which is the exact regression
    // this file exists to catch.
    expect(recordPasses(body, "brokeredForContactId")).toBe(true);
    expect(recordPasses(body, "action")).toBe(true);
    // ...and INSIDE the `withTenant` callback, which is what "in the
    // same transaction" means: an audit row written after it committed
    // describes something that may not have happened.
    expect(callPosition(body, "record")).toBeGreaterThan(callPosition(body, "withTenant"));
  });

  it("only the audit seam and the brokers may name `brokeredForContactId`", () => {
    // The escape that makes a system transaction's trail honest is also
    // the escape that could make it dishonest. `record()` refuses it
    // outside a system transaction at runtime; this says who may even
    // mention it. `audit/catalog.ts` is not on the list: it describes
    // the family in prose, which the AST walk does not see.
    const allowed = [join("audit", "record.ts"), "portal-writes.ts"];
    const offenders = walk(SRC)
      .filter((f) => !isTest(f))
      .filter((f) => namesIdentifier(parse(f), "brokeredForContactId"))
      .map((f) => relative(SRC, f))
      .filter((f) => !allowed.some((suffix) => f.endsWith(suffix)));
    expect(offenders).toEqual([]);
  });

  it("no portal route reaches for the member plane's action runner", () => {
    // `runAction`/`runForm` map an AuthzError to three distinct messages,
    // which on this plane are three facts about the agency.
    const offenders = walk(join(SRC, "app"))
      .filter((f) => f.includes(PORTAL_ROUTES) && !isTest(f))
      .filter((f) =>
        importedFrom(parse(f), "@/lib/server-actions").some(
          (name) => name === "runAction" || name === "runForm",
        ),
      )
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("what the broker takes back from `requests.ts` is a closed, pinned shape", () => {
    // THE GUARANTEE THIS SLICE ACTUALLY HAS, stated as a test rather
    // than as a hope (both reviews raised the gap from opposite ends).
    // `requests.ts` is scanned by the portal tripwire's STRUCTURAL tier
    // but not its TEXT tier — its prose necessarily spells internal
    // column names — so the thing that must not drift is what crosses
    // from it into a file a contact's response is built from. Today that
    // is five fields, none of them a member id, a state name or a body.
    // A sixth is a decision somebody has to make on purpose.
    const source = parse(join(SRC, "modules", "work", "requests.ts"));
    let fields: string[] | null = null;
    for (const statement of source.statements) {
      if (!ts.isTypeAliasDeclaration(statement)) continue;
      if (statement.name.text !== "CreatedRequest") continue;
      if (!ts.isTypeLiteralNode(statement.type)) continue;
      fields = statement.type.members
        .map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : "?"))
        .sort();
    }
    expect(fields, "CreatedRequest must be an inline type literal").not.toBeNull();
    expect(fields).toEqual(["clientId", "id", "number", "projectId", "projectKey"]);
  });

  it("every portal server action derives its principal from the session", () => {
    const actions = walk(join(SRC, "app"))
      .filter((f) => f.includes(PORTAL_ROUTES) && !isTest(f))
      .filter((f) => /^["']use server["']/m.test(readFileSync(f, "utf8")));
    expect(actions.length).toBeGreaterThan(0);
    for (const file of actions) {
      const text = readFileSync(file, "utf8");
      expect(text, relative(SRC, file)).toContain("requirePortalContext()");
      // A portal action may not READ an identity out of the request. The
      // check is on the `field(formData, "…")` / `formData.get("…")`
      // ARGUMENT rather than on the word anywhere in the file, so a
      // docblock explaining the rule does not fail it.
      for (const forbidden of ["tenantId", "contactId", "clientId", "memberId"]) {
        expect(
          new RegExp(`(formData|fd)[^\\n]{0,40}["']${forbidden}["']`).test(text),
          `${relative(SRC, file)} reads ${forbidden} out of the form`,
        ).toBe(false);
      }
    }
  });
});
