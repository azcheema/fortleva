import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * "VIEW AS CLIENT" RUNS THE CLIENT'S OWN CODE — the import-graph
 * assertion the pins name by name.
 *
 * AUTHZ.md §11 and SECURITY.md §7 both say it and SECURITY.md gives the
 * reason in six words: *a separate preview renderer is how previews
 * lie*. A member-facing "what the client sees" panel that built its own
 * query would be right on the day it was written and wrong on every day
 * after — every narrowing the projection gains, every column it drops,
 * every filter a review adds to it would have to be copied by hand into
 * a second file nobody thinks of as safety-critical. Then the preview
 * says "the client cannot see this" and the client can.
 *
 * So this file pins the two halves of the claim, structurally:
 *
 *   1. The preview reads through `listPortalTasks` and touches no work
 *      table of its own.
 *   2. The preview RENDERS through the portal's own components.
 *
 * AND A THIRD THING, which is not about previews at all. It pins the
 * closed set of files that may SYNTHESISE a `PortalPrincipal`. That type
 * carries `gates`, a caller-supplied map of the tenant's entitlement
 * state, and `src/portal/authorize.ts` closes the hazard with a RULE
 * rather than a mechanism, exactly as AUTHZ §7.5 does for
 * `MemberActor.mfa`: only `requirePortalContext()` builds one. The
 * slice-3 review sharpened the risk — not a route spoofing all-ok, but a
 * route reusing a gates map resolved for ANOTHER tenant, which would let
 * one agency's plan decide another's — and named View-as-Contact as the
 * slice that would first build a principal outside that function. This
 * is that slice, and this test is what the rule gets in exchange.
 *
 * SAID PRECISELY, because the first draft of this paragraph called it a
 * MECHANISM and two reviews caught that independently: these are
 * TRIPWIRES ON THE HONEST SHAPE, not proofs. `buildsPrincipal` sees an
 * object literal (and a `PortalPrincipal` annotation); it does not see
 * `{ ...base, gates }`, an `Object.assign`, a principal assembled over
 * two statements, or a factory in a third file. `delegatesOf` resolves
 * `tx.<name>` and `tx["<name>"]`; it does not follow an aliased handle.
 * Closing those needs a type checker, which this suite deliberately does
 * not have (it must run with no `DATABASE_URL` and no generated client).
 * What they buy is that the PLAUSIBLE version of each mistake — the one
 * someone writes while meaning well — fails a test instead of reaching a
 * review that might or might not happen.
 */

const SRC = join(__dirname, "..");

/** The closed set. Add a file here only with the reasoning above in hand. */
const PRINCIPAL_BUILDERS = [
  // The portal plane's own: identity from the contact session, gates
  // resolved for the tenant that session just proved.
  join("portal", "context.ts"),
  // The member plane's only one: every field read from the contact ROW
  // inside the member's RLS-scoped transaction (Phase 3 slice 4).
  join("projects", "portal-preview.ts"),
].sort();

/** The four fields that make an object a `PortalPrincipal`. */
const PRINCIPAL_KEYS = ["contactId", "tenantId", "clientId", "gates"] as const;

const sources = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "generated" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sources(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    // Tests build principals by hand on purpose — `portal.dbtest.ts` and
    // `portal-authz.dbtest.ts` exist to hand `authorizePortal` a
    // principal it must refuse. Scanning them would fail this for doing
    // the right thing (the same carve-out `portal-projections.test.ts`
    // makes, for the same reason).
    if (/\.(test|dbtest)\.[cm]?tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
};

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);

const eachNode = (node: ts.Node, fn: (n: ts.Node) => void): void => {
  fn(node);
  node.forEachChild((child) => eachNode(child, fn));
};

/**
 * Object literals carrying every key of a `PortalPrincipal`, OR a
 * variable declared as one. The second arm is what catches the shape the
 * first cannot see — `const p: PortalPrincipal = { ...base, gates }` —
 * which is also the shape a route reusing another tenant's gates map
 * would most naturally reach for (review).
 */
const buildsPrincipal = (file: string): boolean => {
  let found = false;
  eachNode(parse(file), (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.type &&
      ts.isTypeReferenceNode(node.type) &&
      ts.isIdentifier(node.type.typeName) &&
      node.type.typeName.text === "PortalPrincipal"
    ) {
      found = true;
      return;
    }
    if (!ts.isObjectLiteralExpression(node)) return;
    const keys = new Set(
      node.properties
        .map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : null))
        .filter((n): n is string => n !== null),
    );
    if (PRINCIPAL_KEYS.every((k) => keys.has(k))) found = true;
  });
  return found;
};

/**
 * Prisma delegates reached as `tx.<name>.<method>(…)` — and as
 * `tx["<name>"].<method>(…)`, which the first cut missed. That is not a
 * hypothetical evasion: `portal-projections.test.ts` carries a control
 * case for exactly it, because an element-access delegate is how a read
 * hides from a walk that only knows dotted names. An UNRESOLVABLE
 * receiver (`const d = tx.workItem; d.findMany(…)`) is still invisible
 * here; the header says so rather than implying otherwise.
 */
const delegateName = (receiver: ts.Expression): string | null => {
  if (ts.isPropertyAccessExpression(receiver)) {
    if (!ts.isIdentifier(receiver.expression) || receiver.expression.text !== "tx") return null;
    return ts.isIdentifier(receiver.name) ? receiver.name.text : null;
  }
  if (ts.isElementAccessExpression(receiver)) {
    if (!ts.isIdentifier(receiver.expression) || receiver.expression.text !== "tx") return null;
    return ts.isStringLiteralLike(receiver.argumentExpression)
      ? receiver.argumentExpression.text
      : // A computed delegate name resolves to nothing a reader can check,
        // so it is reported as an offence rather than skipped.
        "<computed>";
  }
  return null;
};

const delegatesOf = (file: string): Set<string> => {
  const found = new Set<string>();
  eachNode(parse(file), (node) => {
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return;
    const name = delegateName(node.expression);
    if (name !== null) found.add(name);
  });
  return found;
};

const PREVIEW = join(SRC, "projects", "portal-preview.ts");
const PROJECT_LAYOUT = join(SRC, "app", "(tenant)", "(authed)", "projects", "[key]", "layout.tsx");
const PORTAL_TAB = join(
  SRC,
  "app",
  "(tenant)",
  "(authed)",
  "projects",
  "[key]",
  "portal",
  "page.tsx",
);

describe("view-as-client reuses the contact's own code", () => {
  it("only the two sanctioned files build a PortalPrincipal", () => {
    const builders = sources(SRC)
      .filter(buildsPrincipal)
      .map((f) => relative(SRC, f))
      .sort();
    expect(builders).toEqual(PRINCIPAL_BUILDERS);
  });

  it("the preview reads through the projection, not around it", () => {
    const text = readFileSync(PREVIEW, "utf8");
    expect(text).toContain("listPortalTasks");
    // It authorises a member and picks a contact; anything else it read
    // for itself would be a second projection wearing a member's
    // principal, which is the shape this test exists to refuse.
    expect([...delegatesOf(PREVIEW)].sort()).toEqual(["contact", "project"]);
  });

  it("the Portal tab is hidden on all four gates, not on the permission alone", () => {
    // `isAuthorized` runs gate 4 only. A tab gated on it stays lit for a
    // tenant whose plan or preference has the portal off, and the page
    // behind it — which opens with `requireAccess` — then throws into an
    // error boundary. Measured, 2026-09-21; this is the pin.
    // A REGEX, not a whitespace-exact `toContain`: that call sits near
    // the print width, and a Prettier reflow of its argument list would
    // otherwise break a security pin with a message naming no cause
    // (review).
    const text = readFileSync(PROJECT_LAYOUT, "utf8");
    expect(text).toMatch(/hasAccess\(\s*tx\s*,[\s\S]{0,120}?"project:manage_portal"\s*\)/);
    expect(text).not.toMatch(/isAuthorized\([\s\S]{0,120}?project:manage_portal/);
  });

  it("the Portal tab renders through the portal's own components", () => {
    const text = readFileSync(PORTAL_TAB, "utf8");
    expect(text).toContain('from "@/app/(portal)/portal/task-list"');
    expect(text).toContain("ProjectTasks");
    // The nothing-shared state too: a second copy of it is how the
    // member's page goes on promising what the client's stopped saying.
    expect(text).toContain("PortalTasksEmpty");
  });
});
