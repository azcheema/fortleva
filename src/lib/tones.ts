/**
 * The six-tone semantic set (DESIGN SPEC §2.5).
 *
 * A tinted chip is <tone>-100 fill with <tone>-800 text in light
 * (measured 7.1-7.9:1) and <tone>-950 / <tone>-300 in dark (10.7:1+).
 * The class strings are STATIC so Tailwind can see them at build time —
 * never build a tone class by interpolation.
 *
 * One prohibition holds product-wide: a filled warm pill means "Client
 * can see" and nothing else, so `caution` exists only as a tint.
 */

export const TONES = ["neutral", "brand", "caution", "success", "danger", "quiet"] as const;
export type Tone = (typeof TONES)[number];

/** Tinted chip surface + label. */
export const TONE_CHIP: Record<Tone, string> = {
  neutral: "bg-(--tone-neutral-bg) text-(--tone-neutral-fg)",
  brand: "bg-(--tone-brand-bg) text-(--tone-brand-fg)",
  caution: "bg-(--tone-caution-bg) text-(--tone-caution-fg)",
  success: "bg-(--tone-success-bg) text-(--tone-success-fg)",
  danger: "bg-(--tone-danger-bg) text-(--tone-danger-fg)",
  quiet: "bg-transparent text-(--tone-quiet-fg) line-through",
};

/** Outline chip: hairline in the tone, label in the tone. */
export const TONE_OUTLINE: Record<Tone, string> = {
  neutral: "border-(--tone-neutral-line) text-(--tone-neutral-fg)",
  brand: "border-(--tone-brand-line) text-(--tone-brand-fg)",
  caution: "border-(--tone-caution-line) text-(--tone-caution-fg)",
  success: "border-(--tone-success-line) text-(--tone-success-fg)",
  danger: "border-(--tone-danger-line) text-(--tone-danger-fg)",
  quiet: "border-(--tone-quiet-line) text-(--tone-quiet-fg)",
};

/** The tone's rule colour: a 2px leading bar, an icon, a sparkline. */
export const TONE_LINE: Record<Tone, string> = {
  neutral: "text-(--tone-neutral-line)",
  brand: "text-(--tone-brand-line)",
  caution: "text-(--tone-caution-line)",
  success: "text-(--tone-success-line)",
  danger: "text-(--tone-danger-line)",
  quiet: "text-(--tone-quiet-line)",
};

export const TONE_BORDER_L: Record<Tone, string> = {
  neutral: "border-l-(--tone-neutral-line)",
  brand: "border-l-(--tone-brand-line)",
  caution: "border-l-(--tone-caution-line)",
  success: "border-l-(--tone-success-line)",
  danger: "border-l-(--tone-danger-line)",
  quiet: "border-l-(--tone-quiet-line)",
};

/** Callout: tinted surface, hairline, 2px leading bar in the tone. */
export const TONE_CALLOUT: Record<Tone, string> = {
  neutral: "bg-(--tone-neutral-bg) text-(--tone-neutral-fg) border-(--tone-neutral-line)/30",
  brand: "bg-(--tone-brand-bg) text-(--tone-brand-fg) border-(--tone-brand-line)/30",
  caution: "bg-(--tone-caution-bg) text-(--tone-caution-fg) border-(--tone-caution-line)/30",
  success: "bg-(--tone-success-bg) text-(--tone-success-fg) border-(--tone-success-line)/30",
  danger: "bg-(--tone-danger-bg) text-(--tone-danger-fg) border-(--tone-danger-line)/30",
  quiet: "bg-transparent text-(--tone-quiet-fg) border-(--tone-quiet-line)/30",
};
