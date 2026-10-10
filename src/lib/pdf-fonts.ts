import path from "node:path";

import { Font } from "@react-pdf/renderer";

/**
 * THE PDFS' ONE FONT FAMILY — Inter 4.1 static (SIL OFL 1.1,
 * `src/modules/invoicing/pdf/fonts/OFL-Inter.txt`), registered ONCE per
 * process for every PDF Fortleva draws: the invoice (Phase 4 slice 108) and
 * the contract (slice 112). One registration, because react-pdf keys fonts
 * by family: two modules each registering "Inter" with a different set of
 * faces would leave whichever ran second deciding the other's.
 *
 * The files come from the release's `extras/ttf/`
 * (https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip):
 * Regular 40d692fc…, SemiBold 78a843fa… (slice 108), Italic bbc051dd… and
 * SemiBoldItalic eff2930c… (slice 112 — a contract's text has emphasis; an
 * invoice draws no italic, so its output is unchanged). Read from disk, so
 * `next.config.ts` traces the folder into every route that draws one.
 *
 * Imported only from the renderers, which are loaded with a dynamic
 * `import()` (`@react-pdf/renderer` is ESM-only).
 */

const FONT_DIR = path.join(process.cwd(), "src", "modules", "invoicing", "pdf", "fonts");
let registered = false;

export function registerPdfFonts(): void {
  if (registered) return;
  Font.register({
    family: "Inter",
    fonts: [
      { src: path.join(FONT_DIR, "Inter-Regular.ttf"), fontWeight: 400 },
      { src: path.join(FONT_DIR, "Inter-Italic.ttf"), fontWeight: 400, fontStyle: "italic" },
      { src: path.join(FONT_DIR, "Inter-SemiBold.ttf"), fontWeight: 600 },
      { src: path.join(FONT_DIR, "Inter-SemiBoldItalic.ttf"), fontWeight: 600, fontStyle: "italic" },
    ],
  });
  // Never hyphenate: an org. number, an IBAN or a company name split with a
  // hyphen would print a different value.
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}
