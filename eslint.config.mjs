import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/generated/**",
  ]),
  {
    // One-seam rule (TENANCY.md §3): no code path reaches the database
    // except through withTenant()/withPlatform(). The raw Prisma client
    // and the generated client are importable only inside src/db.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/db/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/generated/prisma/client", "**/generated/prisma/client"],
              message:
                "Import the data layer through '@/db' (withTenant/withPlatform) — TENANCY.md one-seam rule. Types are fine via '@/generated/prisma/models'.",
              allowTypeImports: true,
            },
            {
              group: ["@/db/client", "**/db/client"],
              message: "The base Prisma client is module-private to src/db.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
