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

/**
 * EVERY EXPORTED top-level function of a broker, as `[name, body]`.
 *
 * The two ordering/attribution pins below used to name
 * `createPortalRequest` and slice out that one body — which was true of
 * the module while it had one writer, and stopped being true the moment
 * it had two. A fresh security review caught it on slice 6c's third
 * commit: `setPortalTaskDone` had shipped with the file-scoped pins
 * covering it and the per-function ones not, so deleting
 * `brokeredForContactId` from its audit row, or moving `authorizePortal`
 * inside its system transaction, left `pnpm test` green.
 *
 * So the pins iterate instead of naming, and the NEXT broker is covered
 * on the day it is written rather than on the day somebody remembers.
 * Exported only: a module-private helper is not a write a contact can
 * reach, and `requests.ts`-style row shapers are deliberately not here.
 */
const exportedBodies = (file: string): [string, ts.Block][] => {
  const source = parse(file);
  const out: [string, ts.Block][] = [];
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.body &&
      statement.name &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      out.push([statement.name.text, statement.body]);
    }
  }
  return out;
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

/**
 * BROKERED READS — the closed set of exported broker functions that
 * write no audit row, because nothing happened (the portal
 * files-and-services slice, 2026-09-27).
 *
 * `readPortalFileVersions` reads `file_version` as `system` on the
 * portal's behalf: the table is class A (`portal_deny`), so the newest
 * version of a shared file — its number, date and size — and the
 * Client Timeline's document branch can come from nowhere else. It is
 * a READ, so the "audit row names the contact" pin below does not apply
 * to it; every OTHER pin does — it authorizes under the contact before
 * the system transaction opens, its principal literal is inline, and
 * it lives in a `portal-writes.ts` so that "this code runs as system"
 * stays a property of the filename. And one pin of its own: a brokered
 * read must call `record` NOWHERE, because a read that audits is a
 * write that has misnamed itself.
 *
 * A closed, named list rather than a rule ("exported functions without
 * `record`"), for the reason `SESSIONLESS_ACTIONS` is: the reviewable
 * moment is adding an entry here, and a broker that FORGOT its audit
 * row must fail the pin, not slide into the exemption.
 */
const BROKERED_READS: readonly (readonly [string, string])[] = [
  [join("documents", "portal-writes.ts"), "readPortalFileVersions"],
  // Phase 3V slice 91: is the client's door to their logins open in this
  // session, and until when — a time, read from the class-A door row;
  // asking is not opening, so nothing is audited.
  [join("modules", "vault", "portal-writes.ts"), "readPortalLoginsDoor"],
  // Phase 3V slice 93: where the client's SEALED logins stand (a count, the
  // newest ask and what became of it), the one bit the portal's nav asks,
  // and — behind an open door, while an ask has them open — the sealed
  // logins' names. Class-A rows and INTERNAL logins a contact's own
  // transaction cannot read; reading is not looking (each look at a field
  // is `lookAtSealedLogin`, audited), so nothing here is.
  [join("modules", "vault", "sealed-portal-writes.ts"), "readSealedPortalState"],
  [join("modules", "vault", "sealed-portal-writes.ts"), "portalHasSealedLogins"],
  [join("modules", "vault", "sealed-portal-writes.ts"), "listSealedPortalLogins"],
  // Phase 3V slice 96 (C64): whether this contact may hand a login over now
  // (a tenant preference and their standing — the home's one bit), and the
  // logins THEY handed over, by name and date — INTERNAL rows a contact's
  // own transaction cannot read. Reading is not handing over (that is
  // `submitPortalCredential`, audited), so nothing here is.
  [join("modules", "vault", "submission-portal-writes.ts"), "portalCanSendLogins"],
  [join("modules", "vault", "submission-portal-writes.ts"), "readPortalSubmissions"],
];

/**
 * THE ANNOUNCERS — the closed set of files that open a SYSTEM transaction
 * because a contact acted, and write only to the members' inboxes (the
 * sign-off slice, 2026-09-27; a security review asked for the pin).
 *
 * `src/portal/signoff-announce.ts` tells the agency about a decision
 * AFTER the census write has committed. It is not a broker — nothing in
 * it is authorized, because the decision it announces already was, under
 * the contact, in its own transaction — and it is deliberately not named
 * `portal-writes.ts`, since the per-broker pins above (authorize before
 * the system transaction, an audit row naming the contact) do not fit a
 * fan-out. What DOES bind it is pinned here: the principal literal is
 * inline `{type:'system'}`; it never audits (the decision's audit row is
 * the census write's); it never opens a contact transaction; and `emit`
 * is the only writer it calls. A second announcer is added by name.
 *
 * `src/modules/work/comment-announce.ts` is the second (Phase 3 slice
 * 75): it tells the agency about a client's comment after the census
 * write committed it, and it writes ONE thing besides `emit` — the
 * task's history row, through `writeContactActivity`, which a contact
 * may not insert (`portal_no_insert` on `work_item_activity`). What each
 * announcer may IMPORT is pinned by equality in `ANNOUNCER_IMPORTS`
 * below — the history writer is on the second's list and nobody else's —
 * and every other pin applies unchanged.
 */
const ANNOUNCERS: readonly string[] = [
  join("portal", "signoff-announce.ts"),
  join("modules", "work", "comment-announce.ts"),
];

/**
 * The VALUES each announcer may import — its whole reach, each as
 * `<module>:<exported name>` (`default` / `*` for those forms). `withTenant`
 * (the system transaction), `emit` (the one writer every announcer has),
 * and, per entry, the reads that choose the receivers and any writer
 * beyond `emit`. Each name is a reviewable entry.
 */
const ANNOUNCER_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  [join("portal", "signoff-announce.ts")]: ["@/db:withTenant", "@/notify/emit:emit"],
  [join("modules", "work", "comment-announce.ts")]: [
    "@/db:withTenant",
    "@/notify/emit:emit",
    // The receivers' read (the project's people, active only).
    "./notify:requestReceivers",
    // The ONE writer beyond `emit`: the task's history row naming the contact.
    "./activity:writeContactActivity",
  ],
};

const isBrokeredRead = (file: string, name: string): boolean =>
  BROKERED_READS.some(([suffix, fn]) => file.endsWith(suffix) && fn === name);

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

  it("authorization happens before the system transaction opens, in EVERY broker", () => {
    const writers = brokerFiles().flatMap((f) => exportedBodies(f).map((b) => [f, ...b] as const));
    // Not vacuous, and the count is not pinned: a new broker must be
    // covered, never merely counted.
    expect(writers.length).toBeGreaterThan(1);
    for (const [file, name, body] of writers) {
      const where = `${relative(SRC, file)}:${name}`;
      const authorize = callPosition(body, "authorizePortal");
      const read = callPosition(body, "withPortalRead");
      const write = callPosition(body, "withTenant");
      expect(read, where).toBeGreaterThan(-1);
      expect(authorize, where).toBeGreaterThan(-1);
      expect(write, where).toBeGreaterThan(-1);
      expect(read, where).toBeLessThan(write);
      expect(authorize, where).toBeLessThan(write);
    }
  });

  it("the audit row names the contact, inside the write's own transaction, in EVERY broker", () => {
    const writers = brokerFiles().flatMap((f) => exportedBodies(f).map((b) => [f, ...b] as const));
    expect(writers.length).toBeGreaterThan(1);
    // The exemption must name functions that EXIST, so a rename cannot
    // quietly turn an entry into dead prose while the renamed function
    // goes unchecked.
    for (const [suffix, fn] of BROKERED_READS) {
      expect(writers.some(([file, name]) => file.endsWith(suffix) && name === fn), `${suffix}:${fn}`).toBe(true);
    }
    for (const [file, name, body] of writers) {
      const where = `${relative(SRC, file)}:${name}`;
      if (isBrokeredRead(file, name)) {
        // A brokered READ audits nothing — anywhere in its body.
        expect(callPosition(body, "record"), `${where} is a brokered read and must not audit`).toBe(-1);
        continue;
      }
    // THE PROPERTY IS PASSED, not merely mentioned. Deleting
    // `brokeredForContactId: principal.contactId` while leaving the
    // comment above it — which names the field — would have left the
    // first cut of this pin green while every portal audit row silently
    // became SYSTEM with a null actor, which is the exact regression
    // this file exists to catch.
      expect(recordPasses(body, "brokeredForContactId"), where).toBe(true);
      expect(recordPasses(body, "action"), where).toBe(true);
      // ...and INSIDE the `withTenant` callback, which is what "in the
      // same transaction" means: an audit row written after it committed
      // describes something that may not have happened.
      expect(callPosition(body, "record"), where).toBeGreaterThan(callPosition(body, "withTenant"));
    }
  });

  it("every announcer runs as `system`, audits nothing, opens no contact transaction, and imports only its admitted names", () => {
    expect(ANNOUNCERS.length).toBeGreaterThan(0);
    for (const suffix of ANNOUNCERS) {
      const file = walk(SRC).find((f) => f.endsWith(suffix));
      expect(file, suffix).toBeDefined();
      const source = parse(file!);
      const principals = withTenantPrincipals(source);
      expect(principals.length, suffix).toBeGreaterThan(0);
      for (const principal of principals) {
        expect(ts.isObjectLiteralExpression(principal), suffix).toBe(true);
        expect(principal.getText(source).replace(/\s|"|'/g, ""), suffix).toBe("{type:system}");
      }
      const text = readFileSync(file!, "utf8");
      expect(text, `${suffix} must not audit`).not.toMatch(/\brecord(Many)?\(/);
      expect(text, `${suffix} must not open a contact transaction`).not.toContain("withPortalRead(");
      expect(text, `${suffix} must not open a contact transaction`).not.toContain("withCensusWrite(");
      expect(text, `${suffix} must not name brokeredForContactId`).not.toContain("brokeredForContactId");
      // The only Prisma WRITE verb in the file is none: `emit` writes.
      expect(text, `${suffix} writes through emit alone`).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
      expect(text, `${suffix} calls emit`).toContain("emit(");
      // No raw SQL: a `$executeRaw` would be a writer no list could name.
      expect(text, `${suffix} writes no raw SQL`).not.toMatch(/\$(execute|query)Raw/);
      // …and EVERY VALUE IT IMPORTS IS ON ITS LIST (`ANNOUNCER_IMPORTS`),
      // by equality. A name-pattern walk over the calls (`write…(`) was
      // the first cut, and the code review listed what walks past it — an
      // `insertActivity(`, a `notifyItemMembers(`, a namespace import's
      // `activity.writeContactActivity(`. Every one of those has to be
      // IMPORTED first, so the import list is the door: a new writer, a
      // renamed one, or a namespace import all change it, and a reviewer
      // meets the change here. Type-only imports carry no code and are
      // not counted.
      //
      // Recorded as `<module>:<EXPORTED name>`, never the local one: an
      // alias (`import { insertActivity as writeContactActivity }`) would
      // otherwise pass under an admitted name (fix-pass review). A dynamic
      // `import(` or a `require(` would be a way round the list, so
      // neither may appear at all.
      expect(text, `${suffix} imports nothing dynamically`).not.toMatch(/\bimport\(|\brequire\(/);
      const imported: string[] = [];
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
        const clause = statement.importClause;
        if (!clause) {
          // A side-effect import runs a module's code: never admitted.
          imported.push(`${(statement.moduleSpecifier as ts.StringLiteral).text}:(side effect)`);
          continue;
        }
        const from = (statement.moduleSpecifier as ts.StringLiteral).text;
        if (clause.name) imported.push(`${from}:default`);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) imported.push(`${from}:*`);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly) imported.push(`${from}:${(element.propertyName ?? element.name).text}`);
          }
        }
      }
      expect(imported.sort(), `${suffix} imports only what its entry admits`).toEqual(
        [...(ANNOUNCER_IMPORTS[suffix] ?? [])].sort(),
      );
    }
  });

  it("only the audit seam and the brokers may name `brokeredForContactId`", () => {
    // The escape that makes a system transaction's trail honest is also
    // the escape that could make it dishonest. `record()` refuses it
    // outside a system transaction at runtime; this says who may even
    // mention it. `audit/catalog.ts` is not on the list: it describes
    // the family in prose, which the AST walk does not see.
    const allowed = [
      join("audit", "record.ts"),
      "portal-writes.ts",
      // **THE AUTH PLANE'S BROKER** (added 2026-09-23 with the portal's
      // sign-in audit trail). It is here for the same reason
      // `portal-writes.ts` is, not as an exception to it: a contact
      // signing in is a contact's own act, recorded under a SYSTEM
      // transaction because no member did it — which is precisely the
      // dishonest-actor problem `brokeredForContactId` exists to fix.
      // Without it every `auth.login_succeeded` on the portal would say
      // SYSTEM with a null actor, in the one table SECURITY.md §7 treats
      // as evidentiary.
      //
      // It is NOT covered by the two per-broker pins above, which walk
      // `portal-writes.ts` files and assert `authorizePortal` before
      // `withTenant` — there is nothing to authorize here, because Better
      // Auth has already decided the outcome and this only records it.
      join("auth", "portal-audit.ts"),
    ];
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

  /**
   * THE ONE PORTAL ACTION THAT HAS NO SESSION TO DERIVE A PRINCIPAL
   * FROM — invitation acceptance (Phase 3, the invite slice's surfaces).
   *
   * A contact presenting a token has no cookie, no tenant and no client:
   * the token is what resolves all three, and `requirePortalContext()`
   * there would redirect every invitee to the sign-in form they cannot
   * use yet. It is the same justification, in the same words, that
   * `src/clients/contact-invite-token.ts` carries for being the one file
   * in the feature allowed `withPlatform`, and it is kept as a NAMED
   * allowlist of exactly one entry for the same reason: a narrow
   * exemption with a reason beats a rule that bends.
   *
   * **THE OTHER HALF OF THE RULE STILL APPLIES TO IT, AND MORE SO** —
   * see the loop below. An action with no session must not read an
   * identity out of the form, because on that path there is nothing
   * underneath to contradict the form if it lies. `email` is on its
   * forbidden list and not on the session-bearing files', because for
   * this one it is exactly the value a caller would want to substitute:
   * the address the new session is minted for must come from the token.
   */
  //
  // **THE SECOND ENTRY** (Phase 3V slice 90, 2026-10-04): a vault SHARE
  // LINK's page. Its visitor is somebody the agency gave one secret to —
  // usually outside the agency, on no plane, never a session — and the
  // token resolves the tenant exactly as an invitation's does. The same
  // rule binds it below: it reads only the token and the typed code, and
  // the address a code goes to is the LINK's (`src/modules/vault/
  // share-open.ts`).
  const SESSIONLESS_ACTIONS: readonly string[] = [
    join("app", "(portal)", "portal", "invite", "[token]", "actions.ts"),
    join("app", "(portal)", "portal", "share", "[token]", "actions.ts"),
  ];

  it("the sessionless allowlist is pinned (two entries — widen only deliberately)", () => {
    expect(SESSIONLESS_ACTIONS).toEqual([
      join("app", "(portal)", "portal", "invite", "[token]", "actions.ts"),
      join("app", "(portal)", "portal", "share", "[token]", "actions.ts"),
    ]);
    for (const rel of SESSIONLESS_ACTIONS) {
      expect(readFileSync(join(SRC, rel), "utf8")).toContain("use server");
    }
  });

  it("every portal server action derives its principal from the session", () => {
    const actions = walk(join(SRC, "app"))
      .filter((f) => f.includes(PORTAL_ROUTES) && !isTest(f))
      .filter((f) => /^["']use server["']/m.test(readFileSync(f, "utf8")));
    expect(actions.length).toBeGreaterThan(0);
    let sessionless = 0;
    for (const file of actions) {
      const text = readFileSync(file, "utf8");
      const rel = relative(SRC, file);
      const exempt = SESSIONLESS_ACTIONS.includes(rel);
      if (exempt) sessionless += 1;
      else expect(text, rel).toContain("requirePortalContext()");
      // A portal action may not READ an identity out of the request. The
      // check is on the `field(formData, "…")` / `formData.get("…")`
      // ARGUMENT rather than on the word anywhere in the file, so a
      // docblock explaining the rule does not fail it.
      const forbidden = exempt
        ? ["tenantId", "contactId", "clientId", "memberId", "email"]
        : ["tenantId", "contactId", "clientId", "memberId"];
      for (const name of forbidden) {
        expect(
          new RegExp(`(formData|fd)[^\\n]{0,40}["']${name}["']`).test(text),
          `${rel} reads ${name} out of the form`,
        ).toBe(false);
      }
    }
    // The allowlist must name files that EXIST and are still actions, so
    // a rename cannot quietly turn an exemption into dead prose while
    // the renamed file goes unchecked.
    expect(sessionless, "an allowlisted sessionless action was not found").toBe(
      SESSIONLESS_ACTIONS.length,
    );
  });
});
