import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/**
 * Shared scanning core for the two import-boundary belt tests
 * (`raw-client-boundary.test.ts`, `import-boundary.test.ts`).
 *
 * TEST-SUPPORT ONLY: imported by those tests and nothing else — it pulls
 * in the `typescript` devDependency, which must never reach a product
 * bundle (nothing outside the two tests imports this module; the tests
 * themselves are exempt from every bundle).
 *
 * Why an AST and not regexes: the 2026-08-31 review of the regex version
 * demonstrated nine evasions with live probes — a backtick specifier
 * `import(`@/db/client`)`, `import ("…")` with a space, a no-whitespace
 * clause `import{x}from"…"`, an import after `;` on the same line, a
 * comment marker inside a string literal swallowing the code after it,
 * `require()`, a deep generated entry point, a `.mjs` file the walker
 * never opened, and a re-export inside an exempt test file. A parser is
 * immune to every spacing, quoting and comment trick by construction,
 * and it makes type-only detection exact instead of heuristic.
 *
 * Residual, accepted: a specifier assembled so that no string-literal
 * FRAGMENT names a guarded path — from variables (`const p = "client";
 * import("@/db/" + p)`) or from segment-by-segment joins
 * (`["@","db","client"].join("/")`) — defeats any static belt; catching
 * it means evaluating the program. Contiguous-literal assembly (concat,
 * template substitution, ternary branches) IS caught. The belts exist
 * to catch drift and casual bypass; deliberate evasion is what review
 * is for.
 */

/** Files the belts open. Wider than ESLint's `{ts,tsx}`: `allowJs` is on
 * and Next compiles .js/.mjs/.mts under src with aliases honoured. */
export const SCAN_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/*
 * There is deliberately NO text prefilter deciding which files get
 * parsed. The rewrite shipped one for speed and three review rounds in
 * a row found literal forms its raw-text terms missed while the AST
 * caught them fine once parsed (dot-segment specifiers, identity
 * escapes, line continuations, comment-split `import/* *\/(`) — a
 * prefilter must match RAW text while the threat is anything that
 * RESOLVES to a guarded module after decode + normalization, which is
 * exactly what parsing does. Parsing all of src costs ~0.5 s for 364
 * files (measured 2026-08-31); soundness is worth far more.
 */

/**
 * Everything in one file that pulls in another module at runtime.
 * `computed` = the specifier is not a plain literal (the raw expression
 * text is reported instead). `bindsValue` = false only for forms erased
 * at compile time (`import type`, all-`type` clauses, `export type`).
 * A side-effect import (`import "x"`) EXECUTES the module, so it binds.
 */
export type ModuleRef = {
  kind: "import" | "export-from" | "dynamic" | "require";
  specifier: string;
  computed: boolean;
  bindsValue: boolean;
  /** Imported/exported source names; "*" for namespace/star/dynamic, "default" for a default binding. */
  names: string[];
  line: number;
  /** For a computed specifier: every string-literal fragment inside the
   * argument expression (a ternary's branches, a concat's parts, a
   * template's quasis). A match on ANY fragment flags the ref — a sound
   * over-approximation, since the fragments are the only static truth a
   * computed expression carries (round-4 review: a ternary of two plain
   * literals slid past the squash). */
  literalParts?: string[];
};

const scriptKindOf = (fileName: string): ts.ScriptKind =>
  fileName.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : fileName.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.(js|mjs|cjs)$/.test(fileName)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;

const parse = (source: string, fileName: string): ts.SourceFile =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));

const literalText = (arg: ts.Expression): string | null =>
  ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : null;

/** Every string-literal fragment anywhere inside an expression. */
const literalPartsOf = (e: ts.Node): string[] => {
  const parts: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts.push(n.text);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) parts.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(e);
  return parts;
};

export function moduleRefsOf(source: string, fileName: string): ModuleRef[] {
  const sf = parse(source, fileName);
  const refs: ModuleRef[] = [];
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = literalText(node.moduleSpecifier as ts.Expression) ?? node.moduleSpecifier.getText(sf);
      const clause = node.importClause;
      const names: string[] = [];
      let bindsValue: boolean;
      if (!clause) {
        bindsValue = true; // `import "x"` — side effects run
      } else if (clause.isTypeOnly) {
        bindsValue = false;
      } else {
        if (clause.name) names.push("default");
        const nb = clause.namedBindings;
        if (nb) {
          if (ts.isNamespaceImport(nb)) names.push("*");
          else for (const el of nb.elements) if (!el.isTypeOnly) names.push((el.propertyName ?? el.name).text);
        }
        // `import {} from "m"` executes m exactly like `import "m"` does;
        // a clause whose only elements are `type` specifiers is erased.
        const emptyBraces = nb !== undefined && ts.isNamedImports(nb) && nb.elements.length === 0 && !clause.name;
        bindsValue = names.length > 0 || emptyBraces;
      }
      refs.push({ kind: "import", specifier: spec, computed: false, bindsValue, names, line: lineOf(node) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = literalText(node.moduleSpecifier) ?? node.moduleSpecifier.getText(sf);
      const names: string[] = [];
      let bindsValue = !node.isTypeOnly;
      if (bindsValue) {
        if (!node.exportClause) {
          names.push("*"); // export * from "x"
        } else if (ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) if (!el.isTypeOnly) names.push((el.propertyName ?? el.name).text);
          // `export {} from "m"` still loads m — same as `import {}`.
          bindsValue = names.length > 0 || node.exportClause.elements.length === 0;
        } else {
          names.push("*"); // export * as ns from "x"
        }
      }
      refs.push({ kind: "export-from", specifier: spec, computed: false, bindsValue, names, line: lineOf(node) });
    } else if (ts.isImportEqualsDeclaration(node)) {
      // `import client = require("@/db/client")` — TS CommonJS interop.
      if (ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) {
        const lit = literalText(node.moduleReference.expression);
        refs.push({
          kind: "require",
          specifier: lit ?? node.moduleReference.expression.getText(sf),
          computed: lit === null,
          bindsValue: !node.isTypeOnly,
          names: [node.name.text],
          line: lineOf(node),
          ...(lit === null ? { literalParts: literalPartsOf(node.moduleReference.expression) } : {}),
        });
      }
    } else if (ts.isCallExpression(node)) {
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const arg = node.arguments[0];
      if ((dynamic || required) && arg) {
        const lit = literalText(arg);
        refs.push({
          kind: dynamic ? "dynamic" : "require",
          specifier: lit ?? arg.getText(sf),
          computed: lit === null,
          bindsValue: true,
          names: ["*"],
          line: lineOf(node),
          ...(lit === null ? { literalParts: literalPartsOf(arg) } : {}),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

/**
 * Exports that hand a guarded module onward — the laundering an exempt
 * file (a test, a grandfathered fixture) must not do even though it may
 * consume the module itself. Catches `export … from "guarded"`,
 * `export * from "guarded"`, `export { localName }` / `export default
 * localName` / `export = localName`, `export const x = localName` (also
 * through await/paren/as), `export const x = await import("guarded")`,
 * and a top-level assignment of a guarded binding into an exported
 * `let`. (A function RETURNING the binding is not caught — accepted
 * residual, same class as assembled specifiers.)
 */
export function launderedExportsOf(
  source: string,
  fileName: string,
  isGuarded: (specifier: string) => boolean,
): string[] {
  const sf = parse(source, fileName);
  const guardedLocals = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const spec = literalText(st.moduleSpecifier as ts.Expression);
    if (spec === null || !isGuarded(spec)) continue;
    const clause = st.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) guardedLocals.add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb) {
      if (ts.isNamespaceImport(nb)) guardedLocals.add(nb.name.text);
      else for (const el of nb.elements) if (!el.isTypeOnly) guardedLocals.add(el.name.text);
    }
  }

  const rootIdentifier = (e: ts.Expression): string | null => {
    let cur: ts.Expression = e;
    while (true) {
      if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) cur = cur.expression;
      else if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
      else if (ts.isNonNullExpression(cur) || ts.isAwaitExpression(cur)) cur = cur.expression;
      else break;
    }
    return ts.isIdentifier(cur) ? cur.text : null;
  };

  /** The value hands over the guarded module: a guarded local binding, or
   * a dynamic `import()`/`require()` of a guarded specifier (unwrapped
   * through await/paren/as/non-null). */
  const guardedValue = (e: ts.Expression): boolean => {
    let cur: ts.Expression = e;
    while (
      ts.isAwaitExpression(cur) ||
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isNonNullExpression(cur)
    ) {
      cur = cur.expression;
    }
    if (ts.isCallExpression(cur)) {
      const dyn =
        cur.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(cur.expression) && cur.expression.text === "require");
      const arg = cur.arguments[0];
      if (dyn && arg) {
        const lit = literalText(arg);
        return lit !== null && isGuarded(lit);
      }
    }
    const root = rootIdentifier(cur);
    return root !== null && guardedLocals.has(root);
  };

  // Guardedness propagates through top-level aliases to a fixpoint:
  // `const c = runtimeClient; export { c };` is the same laundering as
  // the single-statement form (round-4 review found the split evading).
  let grew = true;
  while (grew) {
    grew = false;
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer &&
          !guardedLocals.has(d.name.text) &&
          guardedValue(d.initializer)
        ) {
          guardedLocals.add(d.name.text);
          grew = true;
        }
      }
    }
  }

  const exportedMutable = new Set<string>();
  for (const st of sf.statements) {
    if (
      ts.isVariableStatement(st) &&
      st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      !(st.declarationList.flags & ts.NodeFlags.Const)
    ) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) exportedMutable.add(d.name.text);
      }
    }
  }

  const out: string[] = [];
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st)) {
      // `export default runtimeClient` / `export = runtimeClient`.
      const root = rootIdentifier(st.expression);
      if (root !== null && guardedLocals.has(root)) out.push(st.isExportEquals ? "export =" : "export default");
    } else if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      const spec = st.moduleSpecifier ? literalText(st.moduleSpecifier) : null;
      if (spec !== null && isGuarded(spec)) {
        const els = st.exportClause && ts.isNamedExports(st.exportClause)
          ? st.exportClause.elements.filter((el) => !el.isTypeOnly)
          : null;
        if (els === null || els.length > 0) out.push(`re-export from "${spec}"`);
      } else if (!st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          const name = (el.propertyName ?? el.name).text;
          if (!el.isTypeOnly && guardedLocals.has(name)) out.push(`export { ${name} }`);
        }
      }
    } else if (
      ts.isVariableStatement(st) &&
      st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const d of st.declarationList.declarations) {
        if (d.initializer && guardedValue(d.initializer)) out.push(`export const ${d.name.getText(sf)}`);
      }
    } else if (
      ts.isExpressionStatement(st) &&
      ts.isBinaryExpression(st.expression) &&
      st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(st.expression.left) &&
      exportedMutable.has(st.expression.left.text) &&
      guardedValue(st.expression.right)
    ) {
      out.push(`assignment to exported ${st.expression.left.text}`);
    }
  }
  return out;
}

/**
 * Resolve `.` and `..` segments so `@/db/client/../client` and
 * `@/db/client` are the same specifier (leading `..` runs are kept).
 * Matchers must run on the normalized form — the review demonstrated a
 * dot-segment literal sliding past the suffix-anchored regexes.
 */
export function normalizeSpecifier(spec: string): string {
  const out: string[] = [];
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === ".." && out.length > 0 && out.at(-1) !== "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** The walker's prune rule, exported so the tests can PIN it: `generated`
 * only at the top level (the Prisma output) — the review planted
 * `src/modules/generated/…` and walked straight past an any-depth prune. */
export const isPrunedDir = (relPath: string, entry: string): boolean =>
  entry === "node_modules" || relPath === "generated";

/** Every scannable file under `root`, as posix paths relative to it. */
export function walkSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(root, full).split(sep).join("/");
      if (statSync(full).isDirectory()) {
        if (!isPrunedDir(rel, entry)) walk(full);
      } else if (SCAN_EXTENSIONS.test(entry)) out.push(rel);
    }
  };
  walk(root);
  return out;
}
