import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * NO PERMISSION CHECK FANS OUT ON ONE TRANSACTION.
 *
 * This is AGENTS.md's worst standing trap. Prisma over the `pg` driver
 * adapter does not serialise concurrent statements on an interactive
 * transaction's one connection, and a loser can resolve `undefined` in a
 * function nobody touched (measured 2026-09-22, when a fifth leg in
 * `getItemDetail` broke `readItemComments`). A per-code check is the
 * shape that FANS OUT — `codes.map((c) => isAuthorized(tx, actor, c))` —
 * and on 2026-09-25 nine reads still had it, the shell's layout among
 * them: ten reads at once on every authed render. The connection runs
 * one statement at a time whatever the code says, so the concurrency
 * never bought any speed.
 *
 * AND FOR A MODULE GATE A LOST RACE FAILS OPEN. `requireAccess` reads a
 * feature flag, the tenant's entitlements and a tenant preference before
 * the permission, and all three treat a missing answer as "on"
 * (`flagEnabled`, `parseEntitlements`, `preferenceEnabled`) — so a
 * `requireAccess` leg whose read came back `undefined` would have let a
 * module the tenant had switched off into search. Only the permission
 * read fails closed, by throwing.
 *
 * THE RULES, over every call to a check below (`CHECKS`) in product code:
 *   1. it is not inside the arguments of `Promise.all` / `allSettled` /
 *      `race` / `any` (`Promise.all([isAuthorized(…), read])`);
 *   2. it is not inside a callback an array method calls once per element
 *      (`codes.map((c) => isAuthorized(…))`, the fan-out itself, whether
 *      the array is awaited in place or hoisted into a variable; an async
 *      callback's calls all start before any is awaited). A callback
 *      that runs ONCE — `guarded(…)`, `.then(…)` — is walked through: what
 *      matters is what surrounds it. (`reduce` is not in the list: its
 *      async form awaits the accumulator, which is a sequence);
 *   3. it is awaited where it is made, or returned to a caller who is
 *      (`const pending = isAuthorized(…)` — started early, awaited after
 *      other reads — is concurrency with extra steps) — and so is every
 *      once-callback's call it sits in, or `const gate = guarded(async ()
 *      => requireAccess(…))` starts the check just the same.
 * A callback that opens its OWN transaction (`OPENERS`) has a connection
 * of its own: what surrounds it is not scanned, and inside it scanning
 * starts over. ONE resolution for many codes — `authorizedCodes`,
 * `resolvePermissions`, `effectivePermissions` — is not in `CHECKS` and
 * MAY be a single leg, which is the shape `listItems` and `getItemDetail`
 * settled on after review. The rest of the trap — plain reads batched on
 * one transaction — is NOT pinned here: PLAN §0 records it, it was
 * measured where it bit, and it is not swept.
 *
 * A TRIPWIRE, NOT A PROOF. It matches calls by NAME, so a helper that
 * runs a check inside itself and is then used as a leg slips past, and
 * so does an alias. The dbtests prove what each read answers; this
 * catches the shapes coming back. It parses rather than greps (the
 * reason `src/db/boundary-scan.ts` gives: a parser cannot be fooled by
 * a comment, a string or the spacing), and the self-tests below are
 * what prove each rule can fail at all.
 */

/** Each resolves roles, scope or a module gate with reads of its own. */
const CHECKS: ReadonlySet<string> = new Set([
  "isAuthorized",
  "authorize",
  "requireAccess",
  "hasAccess",
  "flagEnabled",
  "preferenceEnabled",
  "resolveScope",
  "scopeWhere",
  "assertInScope",
  "authorizedResourceIds",
  "authorizedClientIds",
  "authorizePortal",
]);

/** A callback handed to one of these runs in a transaction, on a connection, of its own. */
const OPENERS: ReadonlySet<string> = new Set([
  "withTenant",
  "withPlatform",
  "withUser",
  "withPortalRead",
  "runGuarded",
]);

const BATCHES: ReadonlySet<string> = new Set(["all", "allSettled", "race", "any"]);

/** Array methods that call their callback per element — all at once, for an async one. */
const ITERATORS: ReadonlySet<string> = new Set([
  "from", // `Array.from(xs, (x) => …)` — the only `from` that takes a callback
  "map",
  "flatMap",
  "forEach",
  "filter",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
]);

const calleeName = (call: ts.CallExpression): string | null => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
};

const isBatch = (call: ts.CallExpression): boolean => {
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Promise" &&
    BATCHES.has(callee.name.text)
  );
};

/** A function, if `node` is one — the unit whose caller awaits what it returns. */
const isFunctionLike = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isConstructorDeclaration(node);

/** The call a function is handed to as an argument, if it is a callback. */
const hostOf = (fn: ts.Node): ts.CallExpression | null => {
  const parent = fn.parent;
  return parent && ts.isCallExpression(parent) && parent.arguments.some((a) => a === fn) ? parent : null;
};

/**
 * Rule 3: is the call's promise consumed where it is made? Climbs through
 * wrappers that hand the same promise on — parentheses, casts, a ternary
 * branch, and a `.then` / `.catch` / `.finally` chain — to what finally
 * receives it: an `await`, a `return`, or an arrow's expression body.
 */
const settledWhereMade = (call: ts.CallExpression): boolean => {
  let node: ts.Node = call;
  for (;;) {
    const parent = node.parent;
    if (!parent) return false;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      (ts.isConditionalExpression(parent) && parent.condition !== node)
    ) {
      node = parent;
      continue;
    }
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      ["then", "catch", "finally"].includes(parent.name.text) &&
      parent.parent &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    ) {
      node = parent.parent;
      continue;
    }
    if (ts.isAwaitExpression(parent) || ts.isReturnStatement(parent)) return true;
    return ts.isArrowFunction(parent) && parent.body === node;
  }
};

/** Every call breaking a rule in one file, as `file:line name (rule n)`. */
function fanOutsIn(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const report = (call: ts.CallExpression, name: string, rule: number): void => {
    const { line } = file.getLineAndCharacterOfPosition(call.getStart(file));
    found.push(`${fileName}:${line + 1} ${name} (rule ${rule})`);
  };

  /**
   * Which rule the call's surroundings break, if any, walking up to the
   * first callback that opens its own transaction (exempt) or to the
   * file. Rules 1 and 2 look at the whole way up — a batch or a
   * per-element callback anywhere between the call and its transaction
   * runs it concurrently; rule 3 is about the call itself.
   */
  const ruleBroken = (call: ts.CallExpression): number | null => {
    // Rule 3's subjects: the call itself, and every once-callback's call
    // it is inside on the way up to its transaction.
    const started: ts.CallExpression[] = [call];
    let node: ts.Node = call;
    while (node.parent) {
      const parent: ts.Node = node.parent;
      if (isFunctionLike(node)) {
        const host = hostOf(node);
        const name = host ? calleeName(host) : null;
        if (name !== null && OPENERS.has(name)) break;
        if (name !== null && ITERATORS.has(name)) return 2;
        if (host) started.push(host);
      }
      if (ts.isCallExpression(parent) && isBatch(parent) && parent.arguments.some((a) => a === node)) return 1;
      node = parent;
    }
    return started.every(settledWhereMade) ? null : 3;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== null && CHECKS.has(name)) {
        const rule = ruleBroken(node);
        if (rule !== null) report(node, name, rule);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Product source only: tests may race on purpose, and `generated` is Prisma's. */
function productFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(root, full).split(sep).join("/");
      if (statSync(full).isDirectory()) {
        if (entry !== "node_modules" && rel !== "generated") walk(full);
      } else if (/\.tsx?$/.test(entry) && !/\.(test|dbtest|spec)\.tsx?$/.test(entry)) {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out;
}

describe("the scanner can fail", () => {
  it("rule 1: a check beside a read, in a nested batch, in allSettled, and through a once-callback", () => {
    const source = `
      async function read(tx) {
        const [a, b] = await Promise.all([tx.project.findFirst({}), requireAccess(tx, t, actor, "x:y")]);
        await Promise.all([Promise.all([scopeWhere(tx, actor, opts)]), tx.a.count()]);
        await Promise.allSettled([hasAccess(tx, t, actor, "x:y")]);
        await Promise.all([guarded(async () => assertInScope(tx, actor, ref)), tx.b.count()]);
      }`;
    expect(fanOutsIn(source, "batch.ts")).toEqual([
      "batch.ts:3 requireAccess (rule 1)",
      "batch.ts:4 scopeWhere (rule 1)",
      "batch.ts:5 hasAccess (rule 1)",
      "batch.ts:6 assertInScope (rule 1)",
    ]);
  });

  it("rule 2: the fan-out itself, in place, hoisted, and awaited inside its callback", () => {
    // The shell's layout before 2026-09-25, the same with one line moved,
    // and search's `allowedTypes`, whose check WAS awaited — inside a
    // callback `map` had already started four times over.
    const source = `
      export const layout = () =>
        withTenant(tenantId, principal, async (tx) => {
          const [results, unread] = await Promise.all([
            Promise.all(gated.map((code) => isAuthorized(tx, actor, code))),
            countUnreadIn(tx, ctx),
          ]);
          const checks = gated.map((code) => isAuthorized(tx, actor, code));
          await Promise.all(checks);
          await Promise.all(codes.map(async (code) => {
            try { await requireAccess(tx, tenantId, actor, code); } catch {}
          }));
        });`;
    expect(fanOutsIn(source, "fan-out.ts")).toEqual([
      "fan-out.ts:5 isAuthorized (rule 2)",
      "fan-out.ts:8 isAuthorized (rule 2)",
      "fan-out.ts:11 requireAccess (rule 2)",
    ]);
  });

  it("rule 3: a check started early and awaited after another read, bare or in a once-callback", () => {
    const source = `
      await withTenant(tenantId, principal, async (tx) => {
        const pending = isAuthorized(tx, actor, "time:export");
        const gate = guarded(async () => requireAccess(tx, tenantId, actor, "x:y"));
        const prefs = await readPreferences(tx, tenantId);
        const all = Array.from(codes, (code) => hasAccess(tx, tenantId, actor, code));
        return [prefs, await pending, await gate, all];
      });`;
    expect(fanOutsIn(source, "early.ts")).toEqual([
      "early.ts:3 isAuthorized (rule 3)",
      "early.ts:4 requireAccess (rule 3)",
      "early.ts:6 hasAccess (rule 2)",
    ]);
  });

  it("follows a batch INSIDE a leg that opened its own transaction", () => {
    // `/files` before 2026-09-25: the outer legs are two transactions,
    // which is fine; the batch inside the second is on ONE connection.
    const source = `
      const [documents, caps] = await Promise.all([
        listDocuments(ctx),
        withTenant(tenantId, principal, async (tx) => {
          const [canUpload, canDelete] = await Promise.all([
            isAuthorized(tx, actor, "document:upload"),
            isAuthorized(tx, actor, "document:delete"),
          ]);
          return { canUpload, canDelete };
        }),
      ]);`;
    expect(fanOutsIn(source, "nested.tsx")).toEqual([
      "nested.tsx:6 isAuthorized (rule 1)",
      "nested.tsx:7 isAuthorized (rule 1)",
    ]);
  });

  it("passes what is sound: an own-transaction leg, one resolution as a leg, sequence, a returned check", () => {
    const source = `
      const [clients, canCreate] = await Promise.all([
        listClients(ctx),
        withTenant(tenantId, principal, (tx) => isAuthorized(tx, actor, "client:create")),
      ]);
      const perRow = await Promise.all(ids.map((id) => withTenant(tenantId, principal, (tx) => requireAccess(tx, tenantId, actor, "x:y"))));
      await withTenant(tenantId, principal, async (tx) => {
        const [items, held] = await Promise.all([
          // isAuthorized(tx, actor, "in a comment") is not a call
          tx.workItem.findMany({}),
          authorizedCodes(tx, actor, codes),
        ]);
        const label = "Promise.all([isAuthorized(tx)])";
        for (const code of codes) await requireAccess(tx, tenantId, actor, code);
        const gated = await hasAccess(tx, tenantId, actor, "x:y").catch(() => false);
        return (await isAuthorized(tx, actor, "x:y")) && held && items && label && gated;
      });
      async function gate(tx) {
        return ready ? requireAccess(tx, tenantId, actor, "x:y") : undefined;
      }
      const canView = (tx) => isAuthorized(tx, actor, "x:view");
      await runGuarded(tenantId, actor, async (tx) => {
        await requireAccess(tx, tenantId, actor, "member:manage_roles");
      });
      await withTenant(tenantId, principal, async (tx) =>
        guarded(async () => {
          await requireAccess(tx, tenantId, actor, "budget:manage");
          await assertInScope(tx, actor, { projectId });
        }),
      );`;
    expect(fanOutsIn(source, "fine.ts")).toEqual([]);
  });
});

describe("no permission check fans out on one transaction", () => {
  const root = join(process.cwd(), "src");
  const files = productFiles(root);

  it("scans the product source", () => {
    // A walker that silently found nothing would pass every assertion
    // below; about 500 files on 2026-09-25.
    expect(files.length).toBeGreaterThan(400);
    expect(files).toContain("app/(tenant)/(authed)/layout.tsx");
    expect(files).toContain("notify/inbox.ts");
  });

  it("finds none", () => {
    const found = files.flatMap((rel) => fanOutsIn(readFileSync(join(root, rel), "utf8"), rel));
    expect(found).toEqual([]);
  });
});
