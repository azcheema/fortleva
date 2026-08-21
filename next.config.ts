import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Build parallelism knob for a memory-starved machine: `NEXT_BUILD_CPUS=2
// pnpm build` caps the compile/static-generation workers (each is a Node
// process that dies with Windows' fail-fast 0xC0000409 when the commit
// limit is reached — PLAN §0 trap, 2026-08-21). Unset = Next's default.
const buildCpus = Number(process.env["NEXT_BUILD_CPUS"]);
const experimental: NextConfig["experimental"] =
  Number.isInteger(buildCpus) && buildCpus > 0 ? { cpus: buildCpus } : {};

const nextConfig: NextConfig = {
  reactCompiler: true,
  experimental,
};

// Locale is resolved per request in src/i18n/request.ts (no locale
// segment in URLs — ARC-14, UI.md §8).
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);
