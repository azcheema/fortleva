// Dev helper: create (or top up) a member of a tenant with a known
// password, so scoping can be tested from a second browser profile.
// NOT a product path — the real flow is invite → signup → verify →
// accept (src/members/invites.ts). This script skips email
// verification and the invite, nothing else.
//
//   pnpm exec tsx scripts/create-test-member.ts --email dev-employee@naxdor.test \
//     --name "Test Employee" --role employee [--tenant naxdor] [--password secret123]
//
// Roles: owner | manager | admin | employee (templateKey), or an exact
// role name. Idempotent: re-running adds only what is missing and can
// reset the password with --password.
import { randomInt } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const HELP = `create-test-member — dev-only member seeder

  --email     <address>   required
  --name      <name>      default: derived from the email
  --role      <key|name>  owner | manager | admin | employee, or a role name (default: employee)
  --tenant    <slug>      default: naxdor
  --password  <secret>    default: generated and printed once
  --help
`;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes("--help") || args.length === 0) {
  console.log(HELP);
  process.exit(0);
}

if (process.env["NODE_ENV"] === "production") {
  console.error("refusing to run with NODE_ENV=production");
  process.exit(1);
}

// Unambiguous alphabet: no l/I/1/0/O (a past one-time password was untypable).
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const generatePassword = (len = 16): string =>
  Array.from({ length: len }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

async function main() {
  const email = (flag("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) {
    console.error("--email is required (and must look like an address)\n");
    console.log(HELP);
    process.exit(1);
  }
  const roleArg = flag("role") ?? "employee";
  const tenantSlug = flag("tenant") ?? "naxdor";
  const name = flag("name") ?? email.split("@")[0]!;
  const givenPassword = flag("password");

  const { getPlatformClient } = await import("../src/db/client");
  const platform = getPlatformClient();

  const tenant = await platform.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) throw new Error(`no tenant with slug "${tenantSlug}"`);

  const role =
    (await platform.role.findFirst({
      where: { tenantId: tenant.id, templateKey: roleArg },
    })) ??
    (await platform.role.findFirst({
      where: { tenantId: tenant.id, name: roleArg },
    }));
  if (!role) throw new Error(`no role "${roleArg}" in tenant "${tenantSlug}"`);

  let user = await platform.user.findUnique({ where: { email } });
  let password: string | null = null;

  if (!user) {
    password = givenPassword ?? generatePassword();
    user = await platform.user.create({
      // emailVerified: true skips the verification mail the real signup
      // flow requires (requireEmailVerification is on). platformRole is
      // deliberately NULL — this is a tenant member, never an admin.
      data: { name, email, emailVerified: true, locale: null },
    });
    await platform.account.create({
      data: {
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password: await hashPassword(password),
      },
    });
    console.log(`user created: ${email}`);
  } else {
    console.log(`user exists: ${email}`);
    if (givenPassword) {
      password = givenPassword;
      const account = await platform.account.findFirst({
        where: { userId: user.id, providerId: "credential" },
      });
      const hashed = await hashPassword(password);
      if (account) {
        await platform.account.update({ where: { id: account.id }, data: { password: hashed } });
      } else {
        await platform.account.create({
          data: { userId: user.id, providerId: "credential", accountId: user.id, password: hashed },
        });
      }
      await platform.session.deleteMany({ where: { userId: user.id } });
      console.log("password reset; existing sessions revoked");
    }
  }

  let member = await platform.member.findFirst({
    where: { tenantId: tenant.id, userId: user.id },
  });
  if (!member) {
    member = await platform.member.create({
      data: { tenantId: tenant.id, userId: user.id, title: null },
    });
    console.log(`member created in ${tenantSlug}`);
  } else {
    console.log(`member exists in ${tenantSlug}`);
  }

  const held = await platform.memberRole.findFirst({
    where: { tenantId: tenant.id, memberId: member.id, roleId: role.id },
  });
  if (!held) {
    await platform.memberRole.create({
      data: { tenantId: tenant.id, memberId: member.id, roleId: role.id },
    });
    console.log(`role granted: ${role.name}`);
  } else {
    console.log(`role already held: ${role.name}`);
  }

  await platform.auditEvent.create({
    data: {
      tenantId: tenant.id,
      actorType: "SYSTEM",
      action: "member.joined",
      targetType: "Member",
      targetId: member.id,
      metadata: { seededBy: "scripts/create-test-member.ts", role: role.name },
      visibility: "TENANT",
    },
  });

  console.log("\n─────────────────────────────────────────────");
  console.log(`sign in at http://localhost:3000/login`);
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password ?? "(unchanged — pass --password to reset)"}`);
  console.log(`  role:     ${role.name} in ${tenant.name}`);
  console.log("Use a SEPARATE browser profile / private window — the");
  console.log("session cookie is one per browser profile.");
  console.log("Deny-default: this member sees nothing until assigned");
  console.log("to a client (Client → Overview → Assignments).");
  console.log("─────────────────────────────────────────────\n");

  await platform.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
