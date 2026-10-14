const ROMAN: readonly [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

/**
 * An ordered list's marker as the editor shows it: 1, a, A, i or I (the
 * normaliser's `type`). Pure; shared by every PDF that draws a list — the
 * contract's (Phase 4 slice 112, where it was born) and the monthly report's
 * (Phase 7 slice 119).
 */
export function listMarker(n: number, type: string): string {
  if (type === "a" || type === "A") {
    let out = "";
    for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) out = String.fromCharCode(97 + ((k - 1) % 26)) + out;
    return type === "A" ? out.toUpperCase() : out;
  }
  if (type === "i" || type === "I") {
    let out = "";
    let k = n;
    for (const [v, r] of ROMAN) {
      while (k >= v) {
        out += r;
        k -= v;
      }
    }
    return type === "I" ? out.toUpperCase() : out;
  }
  return String(n);
}
