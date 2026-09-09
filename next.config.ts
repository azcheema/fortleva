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
  // CI already runs `next typegen && tsc --noEmit` over this exact
  // tsconfig project, in the isolation job that the e2e job `needs:`.
  // `next build` then runs tsc over the whole project a SECOND time
  // (28 s measured on run 34155378723: "Compiled successfully in 44s"
  // at 19:29:06, "Generating static pages" at 19:29:34), which buys
  // nothing and is billed. Next 16 already dropped lint-during-build
  // (node_modules/next/dist/docs/01-app/02-guides/upgrading/
  // version-16.md), so this is the remaining duplicate.
  //
  // TWO conditions, and BOTH are load-bearing. The bypass must be
  // bound to the one build that has a compensating typecheck in front
  // of it — ci.yml's `e2e` job, whose `needs: [isolation]` puts
  // `pnpm typecheck` over this same tsconfig project immediately before
  // it — and neither condition achieves that alone:
  //
  //   • `CI` would be wrong outright: every hosted build platform
  //     exports CI=true (Vercel, Netlify, Coolify, Kamal), so the
  //     bypass would escape into deploy builds. Not used.
  //   • `GITHUB_ACTIONS` alone is too broad — true in EVERY workflow,
  //     so a deploy.yml added next year that runs `pnpm build` would
  //     silently ship unchecked types.
  //   • `NEXT_SKIP_TYPECHECK` alone is FORGEABLE. `next build` calls
  //     `loadEnvConfig` BEFORE it loads this file (next/dist/build/
  //     index.js — "so they are available in next.config.js"), so an
  //     untracked `.env.local`, or a deploy platform's env panel, could
  //     set it and disable the type pass on exactly the builds with no
  //     compensating check. playwright.config.ts's dotenv load would
  //     carry it into the local webServer child too.
  //
  // GITHUB_ACTIONS is injected by the runner and is not something a
  // dotenv file in this repo can produce; NEXT_SKIP_TYPECHECK is
  // declared on exactly one job. Requiring both means the bypass needs
  // the runner AND that job. Every other build — local, deploy, a
  // workflow someone adds next year — typechecks by default, which is
  // the safe direction to fail in.
  //
  // Both compared to strings rather than coerced, so a stray
  // `NEXT_SKIP_TYPECHECK=0` does not read as true.
  //
  // If ci.yml's typecheck step or the e2e job's `needs: [isolation]`
  // edge ever goes, drop the env var in the same commit.
  typescript: {
    ignoreBuildErrors:
      process.env["NEXT_SKIP_TYPECHECK"] === "1" &&
      process.env["GITHUB_ACTIONS"] === "true",
  },
};

// Locale is resolved per request in src/i18n/request.ts (no locale
// segment in URLs — ARC-14, UI.md §8).
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);
