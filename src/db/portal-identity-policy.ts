/**
 * The portal identity seam's decisions, as PURE logic — which row the
 * auth path is asking for, and which columns it may write.
 *
 * It lives in its own module IMPORTING NOTHING, for the reason
 * ./with-tenant's neighbours already establish: `./portal-identity`
 * reaches `./client`, which throws without DATABASE_URL, and the unit
 * suite runs before `migrate deploy` with no connection available. A
 * fail-closed rule that can only be exercised against a database is a
 * rule that gets tested against a database or not at all. Everything
 * here is a plain function over plain values, and
 * portal-identity-policy.test.ts pins it with no connection at all.
 *
 * Read ./portal-identity.ts for what uses this, and migration
 * 20260920210000 for the policies these GUC names correspond to.
 */

/** The GUCs the `contact_auth_lookup` policy reads. Nothing else sets them. */
export const EMAIL_GUC = "app.auth_contact_email";
export const ID_GUC = "app.auth_contact_id";

export type ContactAuthKeys = { email?: string; id?: string };

/**
 * Columns the auth path may write. Better Auth's own write surface is
 * already narrowed by declaring the domain columns `input: false` on
 * the instance, but that is a library's promise about request bodies,
 * not a boundary — so the keys are named here as well, and the columns
 * that decide WHICH TENANT a login reaches are additionally pinned by a
 * BEFORE UPDATE trigger. Three layers, because the failure they guard
 * against is a contact being moved into another tenant's data.
 */
export const WRITABLE_COLUMNS: ReadonlySet<string> = new Set([
  "name",
  // `email` IS ON THIS LIST AND IT IS THE KEY THE ADMISSION POLICY
  // MATCHES ON, so it deserves its own note (security review). No
  // enabled endpoint writes it today: `user.changeEmail` is not
  // configured on this instance, and `/update-user` accepts only
  // `input: true` fields, which none of the additional fields are.
  // Before `changeEmail` is ever enabled here, re-check this: the auth
  // path would then be able to rewrite a contact's address under the
  // system principal, and the only thing between that and a collision
  // with another tenant's contact is the global unique index. The
  // immutability trigger does NOT cover `email`.
  "email",
  "emailVerified",
  "image",
  "locale",
  "updatedAt",
]);

/**
 * A write the auth path is not allowed to make. Thrown rather than
 * filtered: a silent drop would let a caller believe it had changed
 * something it had not.
 */
export class PortalIdentityRefused extends Error {
  constructor(what: string) {
    super(`portal-identity: ${what}`);
    this.name = "PortalIdentityRefused";
  }
}

/**
 * Pull the identifying literals out of a Prisma `where`. The adapter
 * emits `{ email: { equals: "x" } }` for reads and the bare
 * `{ email: "x" }` for updates, and may nest either under AND/OR
 * (@better-auth/prisma-adapter, convertWhereClause), so both shapes and
 * nesting are handled. `NOT` is deliberately not followed: a negation
 * identifies no row.
 *
 * Anything it does not recognise yields no key, and a missing key
 * becomes an empty GUC, which matches no row. The failure mode of a
 * shape nobody anticipated is therefore "no rows", never "all rows" —
 * which is the whole reason this is a separate, directly tested
 * function rather than three lines inside a delegate.
 */
export const collectKeys = (where: unknown, out: ContactAuthKeys, depth = 0): void => {
  if (where === null || typeof where !== "object" || depth > 4) return;
  if (Array.isArray(where)) {
    for (const branch of where) collectKeys(branch, out, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (key === "AND" || key === "OR") {
      collectKeys(value, out, depth + 1);
      continue;
    }
    if (key !== "id" && key !== "email") continue;
    const literal =
      typeof value === "string"
        ? value
        : value !== null &&
            typeof value === "object" &&
            typeof (value as { equals?: unknown }).equals === "string"
          ? (value as { equals: string }).equals
          : undefined;
    if (literal !== undefined) out[key] = literal;
  }
};

export const keysOf = (args: { where?: unknown } | undefined): ContactAuthKeys => {
  const out: ContactAuthKeys = {};
  collectKeys(args?.where, out);
  return out;
};

export const assertWritable = (data: unknown): void => {
  if (data === null || typeof data !== "object") return;
  for (const key of Object.keys(data as Record<string, unknown>)) {
    if (!WRITABLE_COLUMNS.has(key)) {
      throw new PortalIdentityRefused(`the auth path may not write contact.${key}`);
    }
  }
};
