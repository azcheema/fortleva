import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * `no-restricted-imports` is configured in several blocks below, and in
 * ESLint flat config the LAST matching block wins a rule OUTRIGHT — it
 * does not merge with earlier ones. So every block that sets this rule
 * must restate everything that should still apply to the files it
 * matches. Writing a new block and listing only its own concern
 * silently switches the others off for most of the tree (measured:
 * adding a portal-seam block turned the raw-client restriction into a
 * batch of "unused eslint-disable" warnings across src/auth).
 *
 * The pieces are therefore named once here and composed per profile.
 */
const RAW_CLIENT_PATTERNS = [
  {
    // Every entry point: internal/class exports the raw client
    // constructor, so the single `client` group was evadable
    // (2026-08-31 review, HIGH).
    group: [
      "@/generated/prisma",
      "@/generated/prisma/**",
      "**/generated/prisma",
      "**/generated/prisma/**",
    ],
    message:
      "Import the data layer through '@/db' (withTenant/withPlatform) — TENANCY.md one-seam rule. Type-only imports are fine.",
    allowTypeImports: true,
  },
  {
    group: ["@/db/client", "**/db/client"],
    message: "The base Prisma client is module-private to src/db.",
  },
];

const PLATFORM_SEAM_PATTERN = {
  group: ["@/db/with-tenant", "**/db/with-tenant"],
  importNames: ["withPlatform", "recordPlatformEvent"],
  message: "withPlatform() is platform-plane only (ARC-16) — and always via '@/db'.",
};

const PORTAL_SEAM_PATTERN = {
  group: ["@/db/portal-identity", "**/db/portal-identity"],
  message:
    "The portal identity seam is module-private to src/db; import it from '@/db', and only in src/auth/portal.ts.",
};

/**
 * One entry per module name: the rule keys `paths` by name, so two
 * entries for "@/db" would not both apply. The named exports are
 * therefore listed together and the message covers both seams.
 */
const dbSeamPath = (importNames) => ({
  name: "@/db",
  importNames,
  message:
    "Seam-grade exports of '@/db'. withPlatform()/recordPlatformEvent() are platform-plane only (ARC-16): src/app/(platform)/**, src/jobs/**, src/db/**, tests, prisma/seed, plus the grandfathered files in this block's ignores — tenant-plane code uses withTenant() and record(). portalAuthClient is the portal AUTH plane's seam and belongs to src/auth/portal.ts alone — portal application code uses withTenant() under the contact principal for reads, or the brokered system principal for writes (AUTHZ.md §8).",
});

const PLATFORM_SEAM_NAMES = ["withPlatform", "recordPlatformEvent"];
const PORTAL_SEAM_NAMES = ["portalAuthClient"];

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
          // The PORTAL seam is restricted here as well as in the block
          // below, because this is the profile that applies to
          // src/jobs/** and src/app/(platform)/** — which the platform
          // block ignores, and which have no business holding portal
          // credentials either.
          paths: [dbSeamPath(PORTAL_SEAM_NAMES)],
          patterns: [...RAW_CLIENT_PATTERNS, PORTAL_SEAM_PATTERN],
        },
      ],
    },
  },
  {
    // Import boundary (ARCHITECTURE.md ARC-16, TENANCY.md §12): the
    // cross-tenant seam withPlatform()/getPlatformClient() is reachable
    // only from the platform plane, jobs, src/db itself, tests and the
    // seed. Tenant-plane services never bypass RLS. The two members/*
    // files below are grandfathered because invitation acceptance and
    // tenant provisioning are cross-tenant by construction (a user
    // without a membership yet); belt two is
    // src/db/import-boundary.test.ts, which pins the same allowlist.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/db/**",
      "src/jobs/**",
      "src/app/(platform)/**",
      "src/**/*.test.ts",
      "src/**/*.dbtest.ts",
      "src/**/dbtest-fixture.ts",
      "src/members/invites.ts",
      "src/members/provisioning.ts",
      // The single permitted importer of recordPlatformEvent, which is
      // the only way to write an audit row with tenant_id NULL. Keep in
      // step with PLATFORM_SEAM_ALLOWED_FILES in belt two.
      "src/auth/platform-audit-hooks.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [dbSeamPath([...PLATFORM_SEAM_NAMES, ...PORTAL_SEAM_NAMES])],
          patterns: [...RAW_CLIENT_PATTERNS, PLATFORM_SEAM_PATTERN, PORTAL_SEAM_PATTERN],
        },
      ],
    },
  },
  {
    // The portal identity seam's ONE permitted importer, exempted from
    // the portal half of the profile above and from nothing else.
    //
    // It is a whole block rather than an entry in that block's
    // `ignores` because the two seams have different allowlists:
    // src/auth/portal.ts must still be barred from withPlatform() and
    // from the raw client. Keep it in step with
    // PORTAL_IDENTITY_ALLOWED_FILES in belt two,
    // src/db/import-boundary.test.ts, which catches what a lint rule
    // cannot — a dynamic import, or a file-level disable comment.
    //
    // src/db/portal-identity-policy.ts is deliberately unrestricted
    // everywhere: pure logic, no imports, no client, no row.
    files: ["src/auth/portal.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [dbSeamPath(PLATFORM_SEAM_NAMES)],
          patterns: [...RAW_CLIENT_PATTERNS, PLATFORM_SEAM_PATTERN],
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
