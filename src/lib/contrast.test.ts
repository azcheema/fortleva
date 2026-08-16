import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { contrastRatio, deltaEOk, hexToLinearSrgb, over, simulateCvd, VISION_TYPES, type Rgb } from "./color";
import { loadDesignTokens, type ThemeName } from "./css-tokens";
import { THEME_COLOR_DARK, THEME_COLOR_LIGHT } from "./theme";

/**
 * THE RELEASE GATE (DESIGN SPEC §2.7 and §9).
 *
 * This test parses src/app/globals.css — the file that actually ships —
 * rather than a copy of the numbers, so it fails the moment somebody
 * lowers a contrast in the stylesheet. It resolves var() chains the way
 * the cascade does, converts OKLCH -> OKLab -> LMS -> clamped linear
 * sRGB -> relative luminance, and asserts a declarative table in BOTH
 * themes.
 *
 * When a row here fails, the fix is the token, never the threshold.
 */

const TOKENS = loadDesignTokens(fileURLToPath(new URL("../app/globals.css", import.meta.url)));
const THEMES: ThemeName[] = ["light", "dark"];

const round = (n: number) => Math.round(n * 100) / 100;

function ratio(a: string, b: string, theme: ThemeName): number {
  const value = TOKENS.ratio(a, b, theme);
  if (value === null) throw new Error(`${theme}: ${a} or ${b} is not a colour this gate can measure`);
  return round(value);
}

function rgb(name: string, theme: ThemeName): Rgb {
  const value = TOKENS.linear(name, theme);
  if (value === null) throw new Error(`${theme}: ${name} is not a colour`);
  return value;
}

const lightness = (name: string, theme: ThemeName): number => {
  const lch = TOKENS.color(name, theme);
  if (!lch) throw new Error(`${theme}: ${name} is not a colour`);
  return lch.l;
};

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

/** Surfaces that body text and muted text actually render on. */
const TEXT_SURFACES = ["--background", "--card", "--popover", "--muted", "--sidebar", "--accent"];
const TONES = ["neutral", "brand", "caution", "success", "danger"] as const;
const CHARTS = [1, 2, 3, 4, 5].map((n) => `--chart-${n}`);
const ENTITIES = Array.from({ length: 12 }, (_, i) => `--entity-${i}`);

/** Surfaces a dot or a series can be drawn on, per theme. */
const NON_TEXT_SURFACES: Record<ThemeName, string[]> = {
  light: ["--background", "--card", "--sidebar", "--muted", "--accent"],
  dark: ["--background", "--card", "--popover", "--accent"],
};

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

describe.each(THEMES)("%s theme — text contrast (WCAG 2.2 SC 1.4.3)", (theme) => {
  it.each(TEXT_SURFACES)(`--foreground on %s is >= ${AA_TEXT}:1`, (surface) => {
    expect(ratio("--foreground", surface, theme)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  // Placeholder text is --muted-foreground, and SC 1.4.3 grants
  // placeholders no exemption whatsoever.
  it.each(TEXT_SURFACES)(`--muted-foreground on %s is >= ${AA_TEXT}:1`, (surface) => {
    expect(ratio("--muted-foreground", surface, theme)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it.each(TONES)("--muted-foreground on the %s tint is >= 4.5:1", (tone) => {
    expect(ratio("--muted-foreground", `--tone-${tone}-bg`, theme)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("--sidebar-foreground on --sidebar is >= 4.5:1", () => {
    expect(ratio("--sidebar-foreground", "--sidebar", theme)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("--secondary-foreground on --secondary is >= 4.5:1", () => {
    expect(ratio("--secondary-foreground", "--secondary", theme)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it.each(TONES)("the %s chip's label on its own fill is >= 4.5:1", (tone) => {
    expect(ratio(`--tone-${tone}-fg`, `--tone-${tone}-bg`, theme)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it.each([
    ["--primary-foreground", "--primary"],
    ["--primary-foreground", "--primary-hover"],
    ["--destructive-foreground", "--destructive"],
    ["--destructive-foreground", "--destructive-hover"],
    ["--success-foreground", "--success"],
    ["--warning-foreground", "--warning"],
    ["--sidebar-primary-foreground", "--sidebar-primary"],
    ["--background", "--foreground"], // the inverted tooltip surface
  ])("%s on %s is >= 4.5:1", (fg, bg) => {
    expect(ratio(fg, bg, theme)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("--vis-client-fg on --vis-client is >= 4.5:1 (safety-critical)", () => {
    expect(ratio("--vis-client-fg", "--vis-client", theme)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe.each(THEMES)("%s theme — non-text contrast (WCAG 2.2 SC 1.4.11)", (theme) => {
  it.each(["--background", "--card", "--popover", "--muted"])(
    `--input boundary on %s is >= ${AA_NON_TEXT}:1`,
    (surface) => {
      expect(ratio("--input", surface, theme)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    },
  );

  // The focus outline sits in the 2px offset gap, so what it must beat
  // is the SURFACE behind the control, not the control's own fill.
  it.each(["--background", "--card", "--popover", "--sidebar"])(
    `--ring on %s is >= ${AA_NON_TEXT}:1`,
    (surface) => {
      expect(ratio("--ring", surface, theme)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    },
  );

  it.each(["--muted", "--card", "--background"])(
    "--fg-disabled on %s is >= 3:1 (disabled is never conveyed by dimming alone)",
    (surface) => {
      expect(ratio("--fg-disabled", surface, theme)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    },
  );

  it("--vis-client-border on --card is >= 3:1", () => {
    expect(ratio("--vis-client-border", "--card", theme)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it.each(CHARTS)(`%s is >= ${AA_NON_TEXT}:1 on every surface it plots on`, (series) => {
    for (const surface of NON_TEXT_SURFACES[theme]) {
      expect(ratio(series, surface, theme), `${series} on ${surface}`).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      );
    }
  });

  it.each(ENTITIES)(`%s is >= ${AA_NON_TEXT}:1 on every surface it appears on`, (entity) => {
    for (const surface of NON_TEXT_SURFACES[theme]) {
      expect(ratio(entity, surface, theme), `${entity} on ${surface}`).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      );
    }
  });

  // The initials are decorative (aria-hidden, the name carries the
  // meaning) but they still have to be readable at 11px.
  it.each(ENTITIES)("--entity-ink on %s is >= 4:1", (entity) => {
    expect(ratio("--entity-ink", entity, theme)).toBeGreaterThanOrEqual(4);
  });
});

describe("dark theme — elevation is lightness, not shadow", () => {
  it.each([
    ["--sidebar", "--background"],
    ["--background", "--card"],
    ["--card", "--popover"],
    ["--popover", "--accent"],
  ])("delta-L(%s, %s) is >= 0.04", (lower, upper) => {
    const delta = Math.abs(lightness(upper, "dark") - lightness(lower, "dark"));
    expect(round(delta)).toBeGreaterThanOrEqual(0.04);
  });

  it("gets lighter with height, never darker", () => {
    const ladder = ["--sidebar", "--background", "--card", "--popover", "--accent"].map((n) =>
      lightness(n, "dark"),
    );
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]!, `step ${i}`).toBeGreaterThan(ladder[i - 1]!);
    }
  });
});

describe("colour-vision deficiency (Machado 2009, severity 1.0)", () => {
  /**
   * The internal chip is transparent, so what a reader actually
   * compares is the CLIENT-VISIBLE fill against the surface showing
   * through the internal one. 0.15 is the floor; the shipped pair
   * measures 0.25-0.29 in light and 0.54-0.59 in dark.
   */
  it.each(THEMES)(
    "%s: the two visibility fills stay >= 0.15 apart for every vision type",
    (theme) => {
      for (const vision of VISION_TYPES) {
        const client = simulateCvd(rgb("--vis-client", theme), vision);
        const internal = simulateCvd(rgb("--card", theme), vision);
        expect(round(deltaEOk(client, internal)), `${theme}/${vision}`).toBeGreaterThanOrEqual(0.15);
      }
    },
  );

  it.each(THEMES)("%s: client-visible never collapses onto the brand colour", (theme) => {
    for (const vision of VISION_TYPES) {
      const client = simulateCvd(rgb("--vis-client", theme), vision);
      const primary = simulateCvd(rgb("--primary", theme), vision);
      expect(round(deltaEOk(client, primary)), `${theme}/${vision}`).toBeGreaterThanOrEqual(0.15);
    }
  });

  it.each(THEMES)(
    "%s: every pair of chart series stays >= 0.10 apart for every vision type",
    (theme) => {
      for (const vision of VISION_TYPES) {
        for (let i = 0; i < CHARTS.length; i++) {
          for (let j = i + 1; j < CHARTS.length; j++) {
            const a = simulateCvd(rgb(CHARTS[i]!, theme), vision);
            const b = simulateCvd(rgb(CHARTS[j]!, theme), vision);
            expect(
              round(deltaEOk(a, b)),
              `${theme}/${vision}: ${CHARTS[i]} vs ${CHARTS[j]}`,
            ).toBeGreaterThanOrEqual(0.1);
          }
        }
      }
    },
  );
});

describe("token hygiene", () => {
  it("has no alpha borders: they cannot be statically measured", () => {
    for (const theme of THEMES) {
      for (const name of ["--border", "--input", "--sidebar-border", "--ring"]) {
        expect(TOKENS.color(name, theme)?.alpha, `${theme}/${name}`).toBe(1);
      }
    }
  });

  it("keeps the sidebar's active colour on the brand, not on a preset leftover", () => {
    for (const theme of THEMES) {
      expect(TOKENS.resolve("--sidebar-primary", theme)).toBe(TOKENS.resolve("--primary", theme));
    }
  });

  it("keeps the sidebar receding: it is darker than the canvas in both themes", () => {
    for (const theme of THEMES) {
      expect(lightness("--sidebar", theme)).toBeLessThan(lightness("--background", theme));
    }
  });

  it("keeps the client-visible fill identical in both themes", () => {
    expect(TOKENS.resolve("--vis-client", "dark")).toBe(TOKENS.resolve("--vis-client", "light"));
    expect(TOKENS.resolve("--vis-client-fg", "dark")).toBe(
      TOKENS.resolve("--vis-client-fg", "light"),
    );
  });

  it("keeps --ring, --destructive and --vis-* out of the tenant hue seam", () => {
    for (const name of ["--ring", "--destructive", "--success", "--warning", "--vis-client"]) {
      for (const theme of THEMES) {
        const raw = TOKENS.vars[theme].get(name) ?? "";
        const chased = raw.startsWith("var(")
          ? (TOKENS.vars[theme].get(raw.slice(4, -1)) ?? raw)
          : raw;
        expect(chased, `${theme}/${name}`).not.toContain("--brand-h");
      }
    }
  });

  it("defines every colour role in both themes", () => {
    for (const name of TOKENS.vars.light.keys()) {
      if (!name.startsWith("--")) continue;
      let isColour = false;
      try {
        isColour = TOKENS.color(name, "light") !== null;
      } catch {
        continue;
      }
      if (!isColour) continue;
      expect(() => TOKENS.color(name, "dark"), `dark/${name}`).not.toThrow();
      expect(TOKENS.color(name, "dark"), `dark/${name}`).not.toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Pairs the screens actually render (stage 5 extension)
 * ------------------------------------------------------------------ */

describe.each(THEMES)("%s theme — pairs the screens actually render", (theme) => {
  // An outline chip's 1px boundary IS the chip: SC 1.4.11 applies to it.
  it.each(TONES)("the %s outline chip's border is >= 3:1 on the card it sits on", (tone) => {
    expect(ratio(`--tone-${tone}-line`, "--card", theme)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  // "Private to team" is a transparent chip: its label sits directly on
  // whatever surface the row uses, and its border is its only boundary.
  it.each(["--background", "--card", "--muted"])(
    "--vis-internal-fg is >= 4.5:1 on %s",
    (surface) => {
      expect(ratio("--vis-internal-fg", surface, theme)).toBeGreaterThanOrEqual(AA_TEXT);
    },
  );

  it.each(["--background", "--card"])("--vis-internal-border is >= 3:1 on %s", (surface) => {
    expect(ratio("--vis-internal-border", surface, theme)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  // A focused control can sit inside a tinted callout or on the active
  // nav item, not only on a plain canvas.
  //
  // --vis-client is deliberately NOT in this list. The focus ring is an
  // outline at offset 2px, so both of its adjacent colours are the
  // SURFACE behind the control, never the control's own fill; the warm
  // select's ring lands on --card, which is asserted above. Adding the
  // fill here would measure a pair that never touches on screen (it
  // reads 2.19:1 light / 1.42:1 dark) and would push the ring off the
  // brand for no accessibility gain.
  it.each([...TONES.map((t) => `--tone-${t}-bg`), "--sidebar-accent"])(
    "--ring is >= 3:1 on %s",
    (surface) => {
      expect(ratio("--ring", surface, theme)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    },
  );

  // The active nav item's label sits on --sidebar-accent, not --sidebar.
  it("--sidebar-foreground on --sidebar-accent is >= 4.5:1", () => {
    expect(ratio("--sidebar-foreground", "--sidebar-accent", theme)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("--sidebar-primary on --sidebar-accent is >= 3:1 (the active indicator)", () => {
    expect(ratio("--sidebar-primary", "--sidebar-accent", theme)).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
  });

  // MemberAvatar: initials are --foreground over the entity-tint wash
  // (15% light / 28% dark, .entity-tint in globals.css). This is the
  // reason the wash carries the identity and the letters do not.
  it.each(ENTITIES)("avatar initials stay >= 4.5:1 over the %s tint", (entity) => {
    const lch = TOKENS.color(entity, theme);
    if (!lch) throw new Error(`${theme}: ${entity} is not a colour`);
    const mix = theme === "dark" ? 0.28 : 0.15;
    const washed = over({ ...lch, alpha: mix }, rgb("--card", theme));
    expect(round(contrastRatio(rgb("--foreground", theme), washed))).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

/* ------------------------------------------------------------------ *
 * Set B: projects, files, members, settings, account
 *
 * These are the pairs those screens put on the glass that the earlier
 * table did not reach: danger and success as PLAIN TEXT on a card
 * (FormMessage, Field errors, the MetricTile delta) rather than inside
 * a tint; tone rules used as marks (the timeline node ring, the
 * progress meter, the toast icons); control boundaries inside a HOVERED
 * table row, whose surface is --accent and not --card; and the warm 2px
 * row cue that says a client can read this row.
 * ------------------------------------------------------------------ */

/** Every tone, including `quiet`, which the tinted-chip tables skip. */
const ALL_TONES = [...TONES, "quiet"] as const;

/** The four surfaces a row, a card body or a menu actually paints. */
const BODY_SURFACES = ["--card", "--background", "--muted", "--accent", "--popover"];

describe.each(THEMES)("%s theme — set B", (theme) => {
  // FormMessage, <Field error> and the destructive menu item put tone
  // text straight on a surface with no tint under it. --destructive is
  // a FILL colour (white label at 4.6:1) and measures 3.90:1 as text on
  // a dark card, which is why danger text is --tone-danger-fg.
  it.each(ALL_TONES)("the %s tone reads as plain text on every body surface", (tone) => {
    for (const surface of BODY_SURFACES) {
      expect(
        ratio(`--tone-${tone}-fg`, surface, theme),
        `--tone-${tone}-fg on ${surface}`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  // Marks, not text: the timeline node's ring and glyph, the progress
  // meter's fill on its --muted track, the toast icons, the quiet
  // outline chip's hairline.
  it.each(ALL_TONES)("the %s tone rule is a legible mark on every body surface", (tone) => {
    for (const surface of BODY_SURFACES) {
      expect(
        ratio(`--tone-${tone}-line`, surface, theme),
        `--tone-${tone}-line on ${surface}`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  // A select or checkbox inside a table row: the row hovers to --accent,
  // so the control's boundary has to clear 3:1 against the HOVER
  // surface, not only against the resting one.
  it.each(["--accent", "--muted"])("--input keeps its boundary on %s", (surface) => {
    expect(ratio("--input", surface, theme)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it.each(["--muted", "--accent"])("--ring is >= 3:1 on %s", (surface) => {
    expect(ratio("--ring", surface, theme)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  // The destructive button draws its own focus outline; at offset 2px
  // what it must beat is the surface behind the button.
  it.each(["--card", "--background"])("--destructive is a visible outline on %s", (surface) => {
    expect(ratio("--destructive", surface, theme)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  // SAFETY-CRITICAL. The 2px left border on a client-visible row is a
  // second channel for "a client can read this", so it is held to the
  // non-text floor on every surface a row is painted on — including the
  // hover surface, where a warm edge is easiest to lose.
  it.each(BODY_SURFACES)("the client-visible row cue is >= 3:1 on %s", (surface) => {
    expect(ratio("--vis-client-cue", surface, theme)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  // "Private to team" is a transparent chip, so on a hovered row its
  // label sits on --accent and its 1px border is its only boundary.
  it("the internal chip survives the row-hover surface", () => {
    expect(ratio("--vis-internal-fg", "--accent", theme)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(ratio("--vis-internal-border", "--accent", theme)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

describe("colour-vision deficiency — the row cue", () => {
  // The chip pair is asserted above; this is the OTHER half of the
  // visibility system. A cue that collapses into its row under deutan
  // would leave the leftmost edge of a files table saying nothing.
  it.each(THEMES)("%s: the row cue stays separable from the row it marks", (theme) => {
    for (const vision of VISION_TYPES) {
      for (const surface of ["--card", "--accent"]) {
        const cue = simulateCvd(rgb("--vis-client-cue", theme), vision);
        const row = simulateCvd(rgb(surface, theme), vision);
        expect(
          round(deltaEOk(cue, row)),
          `${theme}/${vision}/${surface}`,
        ).toBeGreaterThanOrEqual(0.15);
      }
    }
  });
});

describe("browser chrome matches the app canvas", () => {
  // <meta name="theme-color"> cannot read a custom property, so the two
  // literals in src/app/layout.tsx are the only place a colour is
  // written twice. This is the tripwire that keeps them equal.
  it.each([
    ["light", THEME_COLOR_LIGHT],
    ["dark", THEME_COLOR_DARK],
  ] as const)("%s theme-color equals --background", (theme, hex) => {
    const chrome = hexToLinearSrgb(hex);
    const canvas = rgb("--background", theme);
    expect(round(contrastRatio(chrome, canvas))).toBe(1);
  });
});
