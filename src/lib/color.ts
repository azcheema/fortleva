/**
 * Colour maths for the design system (DESIGN SPEC §2.7). Pure, no
 * dependencies, no DOM: used by the contrast release gate
 * (src/lib/contrast.test.ts) and by the /settings/design preview page,
 * which prints the same measured numbers the test asserts.
 *
 * Pipeline: OKLCH → OKLab → LMS → linear sRGB (clamped to gamut) →
 * WCAG relative luminance. Clamping matters: an out-of-gamut OKLCH
 * triple would otherwise produce a luminance no screen can show.
 */

export type Lch = { l: number; c: number; h: number; alpha: number };
export type Rgb = readonly [number, number, number];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** OKLCH (L 0..1, C, H degrees) → linear sRGB, clamped into gamut. */
export function oklchToLinearSrgb({ l, c, h }: Pick<Lch, "l" | "c" | "h">): Rgb {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;

  return [
    clamp01(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    clamp01(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    clamp01(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S),
  ] as const;
}

/** Linear sRGB → OKLab (L, a, b). */
export function linearSrgbToOklab([r, g, b]: Rgb): readonly [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ] as const;
}

const srgbEncode = (v: number): number =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
const srgbDecode = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);

/** Linear sRGB → "#rrggbb". */
export function linearSrgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((v) => Math.round(clamp01(srgbEncode(v)) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

export const oklchToHex = (lch: Pick<Lch, "l" | "c" | "h">): string =>
  linearSrgbToHex(oklchToLinearSrgb(lch));

/** "#rgb" / "#rrggbb" → linear sRGB. */
export function hexToLinearSrgb(hex: string): Rgb {
  const s = hex.replace("#", "").trim();
  const full = s.length === 3 ? s.split("").map((ch) => ch + ch).join("") : s;
  const n = Number.parseInt(full, 16);
  return [
    srgbDecode(((n >> 16) & 0xff) / 255),
    srgbDecode(((n >> 8) & 0xff) / 255),
    srgbDecode((n & 0xff) / 255),
  ] as const;
}

/** WCAG 2.2 relative luminance of a linear-sRGB triple. */
export const relativeLuminance = ([r, g, b]: Rgb): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

/** WCAG 2.2 contrast ratio, 1..21. Order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Euclidean distance in OKLab — perceptual difference, hue included. */
export function deltaEOk(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = linearSrgbToOklab(a);
  const [l2, a2, b2] = linearSrgbToOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * Machado, Oliveira & Fernandes (2009) dichromacy matrices at severity
 * 1.0, applied in LINEAR sRGB (applying them to gamma-encoded values is
 * the classic mistake and overstates the separation).
 */
export const CVD_MATRICES = {
  normal: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
} as const satisfies Record<string, readonly number[]>;

export type VisionType = keyof typeof CVD_MATRICES;
export const VISION_TYPES = Object.keys(CVD_MATRICES) as readonly VisionType[];

export function simulateCvd(rgb: Rgb, vision: VisionType): Rgb {
  const m = CVD_MATRICES[vision];
  const [r, g, b] = rgb;
  return [
    clamp01(m[0]! * r + m[1]! * g + m[2]! * b),
    clamp01(m[3]! * r + m[4]! * g + m[5]! * b),
    clamp01(m[6]! * r + m[7]! * g + m[8]! * b),
  ] as const;
}

/**
 * Parse the colour syntaxes the token layer uses: `oklch(L C H)`,
 * `oklch(L C H / A)`, hex, and `transparent`. Percentages in L are
 * accepted. Returns null for anything else (a var() reference, say —
 * the caller resolves those first).
 */
export function parseColor(input: string): Lch | null {
  const value = input.trim();
  if (value === "transparent") return { l: 0, c: 0, h: 0, alpha: 0 };
  if (value.startsWith("#")) {
    const [r, g, b] = hexToLinearSrgb(value);
    const [l, a, bb] = linearSrgbToOklab([r, g, b]);
    return { l, c: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI, alpha: 1 };
  }
  const m = /^oklch\(\s*([^\s)]+)\s+([^\s)]+)\s+([^\s/)]+)\s*(?:\/\s*([^\s)]+)\s*)?\)$/i.exec(value);
  if (!m) return null;
  const num = (raw: string | undefined, scaleIfPercent: number): number | null => {
    if (raw === undefined) return null;
    const pct = raw.endsWith("%");
    const n = Number.parseFloat(pct ? raw.slice(0, -1) : raw);
    if (!Number.isFinite(n)) return null;
    return pct ? (n / 100) * scaleIfPercent : n;
  };
  const l = num(m[1], 1);
  const c = num(m[2], 0.4);
  const h = num(m[3], 1);
  const alpha = m[4] === undefined ? 1 : (num(m[4], 1) ?? 1);
  if (l === null || c === null || h === null) return null;
  return { l, c, h, alpha };
}

/** Composite a (possibly translucent) colour over an opaque backdrop. */
export function over(fg: Lch, bg: Rgb): Rgb {
  const f = oklchToLinearSrgb(fg);
  if (fg.alpha >= 1) return f;
  const a = fg.alpha;
  return [f[0] * a + bg[0] * (1 - a), f[1] * a + bg[1] * (1 - a), f[2] * a + bg[2] * (1 - a)] as const;
}
