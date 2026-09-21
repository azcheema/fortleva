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
  // The member plane's only one: gates resolved from the CONTACT ROW's
  // own tenant, by a function that takes no tenant id to get them wrong
  // with (Phase 3 slice 5).
  //
  // IT USED TO BE `projects/portal-preview.ts`, and slice 5 moved it
  // rather than adding a third entry. View-as-Contact needed to
  // synthesise a principal too, and the choice was between a set of
  // three — three places to review, three copies of the belt and of the
  // gates-from-the-contact's-tenant rule — or one function both callers
  // share. The obligations are the kind a second copy honours on the day
  // it is written and quietly stops honouring later, so they are
  // executed once, by code.
  join("portal", "synthesise.ts"),
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
const VIEW_AS_SERVICE = join(SRC, "clients", "view-as.ts");
const VIEW_AS_PAGE = join(SRC, "app", "(tenant)", "view-as", "page.tsx");
const VIEW_AS_BANNER = join(SRC, "app", "(tenant)", "view-as", "view-as-banner.tsx");
const PORTAL_PAGE = join(SRC, "app", "(portal)", "portal", "page.tsx");
const PORTAL_FRAME = join(SRC, "app", "(portal)", "portal", "portal-frame.tsx");
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

/**
 * VIEW-AS-CONTACT (Phase 3 slice 5) — the same claim, one level
 * stronger, because this surface is NAVIGABLE and byte-compared.
 *
 * The Portal tab's panel renders one project's task list with the
 * portal's components. View-as renders the portal's own PAGE: the same
 * component `/portal` renders, for the whole client, under a
 * synthesised principal. `e2e/view-as.spec.ts` compares the two outputs
 * byte for byte against a real contact session; these are the
 * structural pins that stop that comparison from quietly becoming
 * vacuous — a byte comparison between two copies of a page passes
 * forever and proves nothing.
 *
 * They are TRIPWIRES ON THE HONEST SHAPE, exactly as the header above
 * says of the others: a `toContain` sees an import, not a call graph.
 * What they buy is that the plausible version of each mistake — the one
 * someone writes while meaning well — fails a test instead of reaching
 * a review that might or might not happen.
 */
describe("view-as-contact renders the contact's own page", () => {
  it("both routes render the SAME component, not two copies of one page", () => {
    // If either route ever draws the task list itself, the byte
    // comparison stops comparing two renderings of one component and
    // starts comparing two components that happen to agree today.
    // IMPORTS, not text. The first cut of this asserted
    // `not.toContain("listPortalTasks")` and went red on its own
    // docblock — which is the failure this file already records for the
    // word `cost`: a test that goes red for the wrong reason teaches
    // people to ignore it. What matters is what the module PULLS IN.
    const importsFrom = (text: string, spec: string) =>
      new RegExp(`^import[^;]*from\\s+["'][^"']*${spec}["']`, "m").test(text);
    for (const file of [PORTAL_PAGE, VIEW_AS_PAGE]) {
      const text = readFileSync(file, "utf8");
      expect(importsFrom(text, "portal-home")).toBe(true);
      expect(importsFrom(text, "task-list")).toBe(false);
      expect(importsFrom(text, "@/modules/work")).toBe(false);
    }
  });

  it("the view-as page reads nothing of its own", () => {
    // It resolves who, synthesises a principal and renders. Every row on
    // the screen comes back under the CONTACT principal, inside
    // <PortalHome>. A query here would be a member-principal read
    // wearing a portal page's clothes.
    expect(delegatesOf(VIEW_AS_PAGE).size).toBe(0);
  });

  it("the view-as service touches two authorization tables and no work table", () => {
    // `requireAccess` and `assertInScope` take the transaction as an
    // ARGUMENT — they are not `tx.<delegate>` reads — so this list is
    // the file's whole surface on the database.
    //
    // `contact`: who may be looked through, and the principal's fields.
    // `project`: the entry point named in the audit row, refused when it
    // belongs to a different client than the contact (a dbtest found an
    // owner could pair them, because `client:view_all` reaches both).
    // Neither is client WORK. A `workItem`, `comment` or `milestone`
    // here would be a member-principal read wearing a portal page's
    // clothes, which is the thing this test exists to refuse.
    expect([...delegatesOf(VIEW_AS_SERVICE)].sort()).toEqual(["contact", "project"]);
  });

  it("the banner sits OUTSIDE the compared region", () => {
    // `data-portal-surface` is the boundary `e2e/view-as.spec.ts` draws
    // the comparison around, and it is marked on the portal's own frame.
    // The banner is the one thing on this route a contact never gets: if
    // it were inside, byte-identity would be impossible by construction
    // and the test would have to be weakened to a subset match — the
    // exact dilution the pins exist to prevent.
    // The ATTRIBUTE, not the word: the banner's own docblock explains
    // why it is outside the boundary, and naming the boundary is not
    // carrying it.
    const marksSurface = (text: string) => /data-portal-surface\s*=/.test(text);
    expect(marksSurface(readFileSync(PORTAL_FRAME, "utf8"))).toBe(true);
    expect(marksSurface(readFileSync(VIEW_AS_BANNER, "utf8"))).toBe(false);
    // …and the page renders the banner BEFORE the frame, which is what
    // "outside" means in a document with no wrapper between them.
    //
    // Measured in the COMPONENT BODY, not the file: the docblock above
    // it names `<PortalHome>` while explaining the arrangement, and a
    // whole-file `indexOf` therefore found the prose first and failed.
    // Third time this file has taught the same lesson in one slice.
    const page = readFileSync(VIEW_AS_PAGE, "utf8");
    const body = page.slice(page.indexOf("export default async function ViewAsPage"));
    expect(body.indexOf("<ViewAsBanner")).toBeGreaterThan(-1);
    expect(body.indexOf("<PortalHome")).toBeGreaterThan(-1);
    expect(body.indexOf("<ViewAsBanner")).toBeLessThan(body.indexOf("<PortalHome"));
  });

  it("the locale is pinned to the contact, ahead of the member session", () => {
    // PLAN §0 named this owed before the slice started: `resolveLocale`
    // prefers the member session, View-as runs under one, and a member
    // reading Swedish would render an English contact's page in Swedish
    // — different bytes for identical data. The ORDER is the pin: the
    // view-as arm must be consulted BEFORE `getMemberSession()`, because
    // below it the member's own locale has already won.
    //
    // MEASURED INSIDE `resolveLocale`'S OWN BODY, and the first cut was
    // not: it compared `indexOf("isViewAsRequest")` against the whole
    // file, so the IMPORT at the top satisfied it and deleting the arm
    // entirely left the test green. Mutation-checked to fail now.
    const text = readFileSync(join(SRC, "i18n", "resolve.ts"), "utf8");
    const body = text.slice(
      text.indexOf("export const resolveLocale"),
      text.indexOf("export const resolvePreferences"),
    );
    expect(body.length).toBeGreaterThan(0);
    const viewAs = body.indexOf("await isViewAsRequest()");
    const member = body.indexOf("await getMemberSession()");
    expect(viewAs).toBeGreaterThan(-1);
    expect(member).toBeGreaterThan(-1);
    expect(viewAs).toBeLessThan(member);
    // THE TIME ZONE GETS THE SAME ORDERING TEST, not a proximity one.
    // The first cut was `toMatch(/isViewAsRequest[\s\S]{0,200}?DEFAULT_TIMEZONE/)`
    // — a regex with no ordering, which would have stayed green with the
    // arm moved BELOW `getMemberSession()`, where the member's own
    // `Member.timezone` silently wins (code review). The e2e cannot see
    // this either: Playwright pins `timezoneId: "Europe/Stockholm"` and
    // `DEFAULT_TIMEZONE` is the same string, so both sides of the byte
    // comparison resolve one zone and the arm is invisible to it. This
    // assertion is the only thing measuring it.
    const zoneBody = text.slice(text.indexOf("export const resolveTimeZone"));
    expect(zoneBody.length).toBeGreaterThan(0);
    const zoneViewAs = zoneBody.indexOf("await isViewAsRequest()");
    const zoneMember = zoneBody.indexOf("await getMemberSession()");
    expect(zoneViewAs).toBeGreaterThan(-1);
    expect(zoneMember).toBeGreaterThan(-1);
    expect(zoneViewAs).toBeLessThan(zoneMember);
    expect(zoneBody).toContain("DEFAULT_TIMEZONE");
  });
});
