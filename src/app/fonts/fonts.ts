import localFont from "next/font/local";

/**
 * Self-hosted type (EU/privacy posture: no CDN, no runtime vendor, no
 * network call at render). Both files are committed next to this module
 * together with their SIL OFL 1.1 licences and the subsetting script
 * that produced them (./build-fonts.mjs).
 *
 * Google's Inter build is stripped of `zero`, `ss01-ss08` and
 * `cv01-cv14` — exactly the features that disambiguate a project key
 * like ACME-12 — which is why this is next/font/local over a variable
 * subset we cut ourselves rather than next/font/google.
 *
 * Never name a loader variable `--font-sans`: it would self-reference
 * Tailwind's theme key and silently resolve to nothing.
 */

export const interVariable = localFont({
  src: "./inter-eu.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  preload: true,
  variable: "--font-inter",
  adjustFontFallback: "Arial",
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
});

export const geistMonoVariable = localFont({
  src: "./geistmono-eu.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  preload: true,
  variable: "--font-geist-mono",
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});
