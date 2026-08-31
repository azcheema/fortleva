import { Prisma } from "@/generated/prisma/client";

/**
 * Refuse a bulk write whose `where` is missing or carries an
 * `undefined` value at any depth: Prisma silently DROPS undefined
 * filters, so `role.deleteMany({ where: { tenantId: undefined } })`
 * deletes EVERY row. On 2026-08-31 exactly that happened on the shared
 * dev database — a dbtest run started before the permission-catalog
 * seed, every fixture's beforeAll threw with its `tenantId` still
 * unassigned, vitest ran the afterAll hooks anyway, and the unfiltered
 * deletes wiped role / role_permission / member_role (and naxdor's
 * member_client / member_invite / document rows) for every tenant until
 * a member FK aborted each hook. The platform client (BYPASSRLS — no
 * RLS backstop) now fails LOUDLY instead. No caller anywhere performs a
 * deliberate unfiltered bulk write, so `where` is simply required.
 */
export const assertNoUndefinedWhere = (where: unknown, path = "where"): void => {
  if (where === undefined) {
    throw new Error(`refusing unfiltered bulk write: ${path} is undefined (Prisma drops undefined filters)`);
  }
  if (where === null || typeof where !== "object") return;
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) {
      throw new Error(
        `refusing unfiltered bulk write: ${path}.${key} is undefined (Prisma drops undefined filters)`,
      );
    }
    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      assertNoUndefinedWhere(value, `${path}.${key}`);
    }
  }
};

export const undefinedWhereGuard = Prisma.defineExtension({
  name: "undefined-where-guard",
  query: {
    $allModels: {
      deleteMany({ args, query }) {
        assertNoUndefinedWhere(args.where);
        return query(args);
      },
      updateMany({ args, query }) {
        assertNoUndefinedWhere(args.where);
        return query(args);
      },
    },
  },
});
