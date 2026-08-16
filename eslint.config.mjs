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
  {
    // No literal user-facing strings in JSX (UI.md §8, ARC-14): every
    // string a person can read comes from src/messages/*.json through
    // next-intl. jsx-no-literals covers JSX text and {"…"} children;
    // ignoreProps must stay true (ignoreProps:false would flag every
    // className/type/name/data-* string), so the user-facing attributes
    // and the conditional/template/logical branches the rule does not
    // see are covered by targeted no-restricted-syntax selectors.
    files: ["src/app/**/*.tsx", "src/components/**/*.tsx"],
    rules: {
      "react/jsx-no-literals": [
        "error",
        {
          noStrings: true,
          ignoreProps: true,
          allowedStrings: [
            "—", "–", "-", "·", "•", "✦", "→", "←", "…", ":", "/", "(", ")", "?", "!", ".", ",", "&", "|",
            "%", "+", "×", "@", "#", "*",
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXAttribute[name.name=/^(placeholder|title|alt|aria-label|aria-description|aria-roledescription|label|description|heading)$/] > Literal",
          message: "User-facing attribute strings must come from next-intl (t('…')).",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(placeholder|title|alt|aria-label|aria-description|aria-roledescription|label|description|heading)$/] > JSXExpressionContainer > :matches(Literal, TemplateLiteral)",
          message: "User-facing attribute strings must come from next-intl (t('…')).",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(placeholder|title|alt|aria-label|aria-description|aria-roledescription|label|description|heading)$/] > JSXExpressionContainer > :matches(ConditionalExpression, LogicalExpression) > Literal",
          message: "User-facing attribute strings must come from next-intl (t('…')).",
        },
        {
          selector:
            "JSXElement > JSXExpressionContainer > :matches(ConditionalExpression, LogicalExpression) > Literal[value=/[A-Za-z\u00C0-\u024F]{2,}/]",
          message: "Conditional user-facing strings in JSX must come from next-intl (t('…')).",
        },
        {
          selector:
            "JSXElement > JSXExpressionContainer > ConditionalExpression > ConditionalExpression > Literal[value=/[A-Za-z\u00C0-\u024F]{2,}/]",
          message: "Conditional user-facing strings in JSX must come from next-intl (t('…')).",
        },
        {
          selector:
            "JSXElement > JSXExpressionContainer > :matches(ConditionalExpression, LogicalExpression) > TemplateLiteral > TemplateElement[value.raw=/[A-Za-z\u00C0-\u024F]{2,}/]",
          message: "Template strings in JSX must come from next-intl (t('…')).",
        },
      ],
    },
  },
]);

export default eslintConfig;
