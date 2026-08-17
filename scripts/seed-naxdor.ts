// Seeds Naxdor as tenant zero (PLAN.md Phase 1): founder user with
// SUPERADMIN platform flag + the Naxdor tenant with system roles and
// the founder seated as owner. Idempotent: skips whatever exists.
// The one-time password prints ONCE — sign in, change it, enroll TOTP
// (owner-equivalent roles are MFA-mandatory, AUTHZ.md §7.5).
import { randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const FOUNDER_EMAIL = "azcheema@gmail.com";
const FOUNDER_NAME = "Ansar Cheema";
// Only used when the founder row does not exist yet (fresh database or a
// restore); the live name is edited on /account, never here.

async function main() {
  const { getPlatformClient } = await import("../src/db/client");
  const { provisionTenant } = await import("../src/members/provisioning");
  const platform = getPlatformClient();

  let user = await platform.user.findUnique({ where: { email: FOUNDER_EMAIL } });
  let oneTimePassword: string | null = null;

  if (!user) {
    oneTimePassword = randomBytes(12).toString("base64url");
    user = await platform.user.create({
      data: {
        name: FOUNDER_NAME,
        email: FOUNDER_EMAIL,
        emailVerified: true,
        platformRole: "SUPERADMIN",
        role: "admin", // Better Auth admin-plugin mirror, never read by authz
        locale: "en",
      },
    });
    await platform.account.create({
      data: {
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password: await hashPassword(oneTimePassword),
      },
    });
    console.log(`Founder user created: ${FOUNDER_EMAIL}`);
  } else {
    if (user.platformRole !== "SUPERADMIN") {
      await platform.user.update({
        where: { id: user.id },
        data: { platformRole: "SUPERADMIN", role: "admin" },
      });
      console.log("Founder platformRole set to SUPERADMIN");
    }
    console.log(`Founder user exists: ${FOUNDER_EMAIL}`);
  }

  const existing = await platform.tenant.findUnique({ where: { slug: "naxdor" } });
  if (existing) {
    console.log("Tenant zero exists: naxdor");
  } else {
    const { tenantId } = await provisionTenant({
      name: "Naxdor",
      slug: "naxdor",
      ownerUserId: user.id,
    });
    console.log(`Tenant zero provisioned: naxdor (${tenantId})`);
  }

  if (oneTimePassword) {
    console.log("\n─────────────────────────────────────────────");
    console.log("ONE-TIME PASSWORD (change at first login, then");
    console.log(`enroll TOTP): ${oneTimePassword}`);
    console.log("─────────────────────────────────────────────\n");
  }

  await platform.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
