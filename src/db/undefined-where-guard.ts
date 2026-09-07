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
 *
 * THE HOOKS ARE KEYED BY OPERATION NAME, so an operation nobody listed
 * here is simply not guarded. `…AndReturn` are separate names, not
 * aliases — `updateManyAndReturn` takes the same optional `where` and
 * does the same unfiltered damage — which is why it is listed below and
 * pinned by the test. The create forms are deliberately absent: they
 * carry no `where` at all, so guarding them would throw on every call.
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

/** Every bulk write that takes a `where`. The hooks below are BUILT
 * from this list rather than written out beside it, so a name added
 * here cannot be forgotten there — which is exactly how
 * `updateManyAndReturn` nearly shipped unguarded. */
export const GUARDED_BULK_OPS = ["deleteMany", "updateMany", "updateManyAndReturn"] as const;

export const undefinedWhereGuard = Prisma.defineExtension({
  name: "undefined-where-guard",
  query: {
    $allModels: {
      // One catch-all that TESTS the operation name, rather than a hook
      // per name: a hook Prisma never calls because nobody wrote it is
      // indistinguishable from a guard that passed. Same shape as the
      // sibling belt in where-injection.ts.
      $allOperations({ operation, args, query }) {
        if ((GUARDED_BULK_OPS as readonly string[]).includes(operation)) {
          assertNoUndefinedWhere((args as { where?: unknown }).where);
        }
        return query(args);
      },
    },
  },
});
