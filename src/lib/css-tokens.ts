import { readFileSync } from "node:fs";

import { contrastRatio, oklchToLinearSrgb, parseColor, type Lch, type Rgb } from "./color";

/**
 * Reads the token layer out of the stylesheet that actually ships.
 *
 * SERVER ONLY (node:fs). Two callers, deliberately the same code path:
 * the release gate in src/lib/contrast.test.ts, and the /settings/design
 * preview — so the numbers the founder reads on screen are the numbers
 * CI asserts, never a hand-maintained copy that can drift.
 *
 * It does what the cascade does, and no more: brace-balanced block
 * extraction, top-level custom-property declarations, then iterative
 * var() substitution with a cycle guard.
 */

export type ThemeName = "light" | "dark";

export type DesignTokens = {
  vars: Record<ThemeName, Map<string, string>>;
  /** Fully substituted value, e.g. "oklch(0.575 0.205 268)". */
  resolve: (name: string, theme: ThemeName) => string;
  /** Parsed colour, or null when the token is not a colour (a shadow, say). */
  color: (name: string, theme: ThemeName) => Lch | null;
  linear: (name: string, theme: ThemeName) => Rgb | null;
  /** WCAG 2.2 contrast ratio between two tokens, or null if either is not a colour. */
  ratio: (a: string, b: string, theme: ThemeName) => number | null;
};

function block(css: string, header: string): string {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{`).exec(css);
  if (!match) throw new Error(`stylesheet has no "${header}" block`);
  let index = match.index + match[0].length;
  const start = index;
  let depth = 1;
  while (index < css.length && depth > 0) {
    const ch = css[index];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    index += 1;
  }
  if (depth !== 0) throw new Error(`unbalanced braces in "${header}"`);
  return css.slice(start, index - 1);
}

function declarations(source: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let buffer = "";
  const flush = () => {
    const colon = buffer.indexOf(":");
    const name = buffer.slice(0, colon).trim();
    if (name.startsWith("--")) out.set(name, buffer.slice(colon + 1).trim());
    buffer = "";
  };
  for (const ch of source) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (ch === ";" && depth === 0) flush();
    else buffer += ch;
  }
  if (buffer.includes(":")) flush();
  return out;
}

export function parseDesignTokens(cssSource: string): DesignTokens {
  const css = cssSource.replace(/\/\*[\s\S]*?\*\//g, "");
  const primitives = declarations(block(css, "@theme static"));
  const light = declarations(block(css, ":root"));
  const dark = declarations(block(css, ".dark"));

  const merged = (isDark: boolean): Map<string, string> => {
    const vars = new Map(primitives);
    for (const [k, v] of light) vars.set(k, v);
    if (isDark) for (const [k, v] of dark) vars.set(k, v);
    return vars;
  };

  const vars: Record<ThemeName, Map<string, string>> = {
    light: merged(false),
    dark: merged(true),
  };

  const resolve = (name: string, theme: ThemeName): string => {
    const table = vars[theme];
    let value = table.get(name);
    if (value === undefined) throw new Error(`${theme}: ${name} is not defined`);
    for (let pass = 0; pass < 24 && value.includes("var("); pass++) {
      value = value.replace(
        /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g,
        (whole, ref: string, fallback?: string) => {
          const next = table.get(ref);
          if (next !== undefined) return next;
          if (fallback !== undefined) return fallback.trim();
          return whole;
        },
      );
    }
    if (value.includes("var(")) throw new Error(`${theme}: ${name} has an unresolvable var() cycle`);
    return value.trim();
  };

  const color = (name: string, theme: ThemeName): Lch | null => parseColor(resolve(name, theme));
  const linear = (name: string, theme: ThemeName): Rgb | null => {
    const lch = color(name, theme);
    return lch ? oklchToLinearSrgb(lch) : null;
  };
  const ratio = (a: string, b: string, theme: ThemeName): number | null => {
    const ra = linear(a, theme);
    const rb = linear(b, theme);
    return ra && rb ? contrastRatio(ra, rb) : null;
  };

  return { vars, resolve, color, linear, ratio };
}

export const loadDesignTokens = (cssPath: string): DesignTokens =>
  parseDesignTokens(readFileSync(cssPath, "utf8"));
