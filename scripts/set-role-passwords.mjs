// Sets passwords for the SQL-created app roles (TENANCY.md §9.2) and
// prints the connection URLs to paste into .env.local / Vercel env.
// Passwords never enter git: generated here, output to stdout only.
//
//   node scripts/set-role-passwords.mjs
//
// Requires DIRECT_URL (owner) in .env.local or the environment.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

function envVar(name) {
  if (process.env[name]) return process.env[name];
  try {
    const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    return env.match(new RegExp(`^${name}="(.+)"`, "m"))?.[1];
  } catch {
    return undefined;
  }
}

const directUrl = envVar("DIRECT_URL");
if (!directUrl) {
  console.error("DIRECT_URL not found in environment or .env.local");
  process.exit(1);
}

// Hex-only passwords: no SQL/URL escaping hazards.
const passwords = {
  app_runtime: randomBytes(24).toString("hex"),
  app_platform: randomBytes(24).toString("hex"),
};

const client = new pg.Client({ connectionString: directUrl });
await client.connect();
for (const [role, pw] of Object.entries(passwords)) {
  await client.query(`ALTER ROLE ${role} PASSWORD '${pw}'`);
}
await client.end();

const direct = new URL(directUrl);
const pooled = new URL(directUrl);
pooled.host = direct.host.replace(/^(ep-[^.]+?)(\.|$)/, "$1-pooler$2");

const url = (base, role, pw) => {
  const u = new URL(base.toString());
  u.username = role;
  u.password = pw;
  return u.toString();
};

console.log("Passwords set. Store these in Bitwarden, then update env files:\n");
console.log(`DATABASE_URL="${url(pooled, "app_runtime", passwords.app_runtime)}"`);
console.log(`PLATFORM_DATABASE_URL="${url(pooled, "app_platform", passwords.app_platform)}"`);
console.log(`# DIRECT_URL stays on the owner role (Prisma Migrate only)`);
