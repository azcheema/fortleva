// @ts-check
/**
 * Reproduces the two committed .woff2 files from their canonical
 * upstream releases. Not part of the app build — run by hand when a
 * font is upgraded, then commit the result:
 *
 *   node src/app/fonts/build-fonts.mjs
 *
 * Requires `pyftsubset` on PATH (pip install "fonttools[woff]" brotli).
 * Everything else is stdlib: nothing is fetched at build or run time by
 * the application itself.
 *
 * Coverage is "EU + client names": Latin-1 (Swedish a-ring/a-diaeresis/
 * o-diaeresis live in U+00C0-00FF), Latin Extended-A for the Polish,
 * Hungarian and Czech letters that turn up in company names, the
 * combining marks, punctuation, currency and the handful of maths and
 * arrow glyphs the UI actually prints.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const UNICODES = [
  "U+0000-00FF",
  "U+0100-017F",
  "U+0192",
  "U+01FA-01FF",
  "U+0218-021B",
  "U+0237",
  "U+02BB-02BC",
  "U+02C6",
  "U+02C7",
  "U+02D8-02DD",
  "U+0300-0304",
  "U+0306-0308",
  "U+030A-030C",
  "U+0326-0329",
  "U+2000-206F",
  "U+2070",
  "U+2074-2079",
  "U+2080-2089",
  "U+20A0-20BF",
  "U+2113",
  "U+2116",
  "U+2122",
  "U+2190-2199",
  "U+2202",
  "U+2206",
  "U+220F",
  "U+2211-2212",
  "U+2215",
  "U+221A",
  "U+221E",
  "U+222B",
  "U+2248",
  "U+2260",
  "U+2264-2265",
  "U+25CA",
  "U+2713",
  "U+FEFF",
  "U+FFFD",
].join(",");

/** @type {{name: string, url: string, member: string, features: string, out: string, licence: string}[]} */
const FACES = [
  {
    name: "Inter 4.1 variable (opsz 14-32, wght 100-900)",
    url: "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip",
    member: "web/InterVariable.woff2",
    features: "kern,liga,calt,tnum,zero,case,ccmp,locl,mark,mkmk,frac,cv01,cv05,ss01",
    out: "inter-eu.woff2",
    licence: "LICENSE.txt -> OFL-Inter.txt",
  },
  {
    name: "Geist Mono 1.7.2 variable (wght 100-900)",
    url: "https://github.com/vercel/geist-font/releases/download/v1.7.2/geist-font-v1.7.2.zip",
    member: "geist-font/GeistMono/webfonts/GeistMono[wght].woff2",
    features: "kern,ccmp,locl,mark,mkmk,frac,ss09",
    out: "geistmono-eu.woff2",
    licence: "geist-font/OFL.txt -> OFL-GeistMono.txt",
  },
];

const work = mkdtempSync(join(tmpdir(), "fortleva-fonts-"));
try {
  for (const face of FACES) {
    console.log(`\n== ${face.name}`);
    const zip = join(work, "src.zip");
    execFileSync("curl", ["-sSL", "--fail", "-o", zip, face.url], { stdio: "inherit" });
    execFileSync("unzip", ["-o", "-q", zip, face.member, "-d", work], { stdio: "inherit" });
    const input = join(work, face.member);
    const output = join(HERE, face.out);
    execFileSync(
      "pyftsubset",
      [
        input,
        `--unicodes=${UNICODES}`,
        `--layout-features=${face.features}`,
        "--flavor=woff2",
        "--no-hinting",
        "--desubroutinize",
        `--output-file=${output}`,
      ],
      { stdio: "inherit" },
    );
    console.log(`   wrote ${face.out}  (licence: ${face.licence})`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
