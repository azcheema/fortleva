import { Prisma } from "@/generated/prisma/client";

import { classOf } from "./model-registry";
import { tenantContextStorage } from "./context";

/**
 * Belt two of the enforcement stack (TENANCY.md §5): inject
 * `where: { tenantId }` into reads/updates/deletes and stamp tenantId
 * into create data, so a developer never writes the filter. It is NOT
 * the mechanism — RLS (belt three) filters regardless. Known escape
 * hatches (nested connect, raw SQL) are closed by composite FKs and
 * RLS, not here.
 */

const READ_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);
const UNIQUE_OPS = new Set(["findUnique", "findUniqueOrThrow"]);
const FILTERED_WRITE_OPS = new Set(["updateMany", "deleteMany"]);

type AnyArgs = Record<string, unknown> & { where?: Record<string, unknown>; data?: unknown };

/** An explicitly supplied foreign tenantId is a forgery or a bug —
 * rejected loudly, never silently rewritten. */
const stamp = (data: object, tenantId: string): object => {
  const supplied = (data as { tenantId?: unknown }).tenantId;
  if (supplied !== undefined && supplied !== tenantId) {
    throw new Error(
      `tenant-where-injection: create data carries tenantId ${String(supplied)} inside a withTenant(${tenantId}) context`,
    );
  }
  return { ...data, tenantId };
};

export const whereInjection = Prisma.defineExtension({
  name: "tenant-where-injection",
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        const ctx = tenantContextStorage.getStore();
        if (!ctx) return query(args); // withPlatform / auth paths: RLS still governs

        const cls = classOf(model);
        const a = (args ?? {}) as AnyArgs;

        if (cls === "tenant" || cls === "audit") {
          if (READ_OPS.has(operation) || FILTERED_WRITE_OPS.has(operation)) {
            a.where = { ...a.where, tenantId: ctx.tenantId };
          } else if (UNIQUE_OPS.has(operation)) {
            // Unique selectors can't take an extra filter; compound
            // tenant-scoped uniques already force tenantId into the
            // selector (§8.2). A bare-id lookup gets tenantId ANDed in.
            a.where = { ...a.where, tenantId: ctx.tenantId } as AnyArgs["where"];
          } else if (operation === "create") {
            a.data = stamp(a.data as object, ctx.tenantId);
          } else if (operation === "createMany") {
            const d = a.data;
            if (Array.isArray(d)) {
              a.data = d.map((row: object) => stamp(row, ctx.tenantId));
            }
          } else if (operation === "update" || operation === "delete" || operation === "upsert") {
            a.where = { ...a.where, tenantId: ctx.tenantId } as AnyArgs["where"];
            if (operation === "upsert" && a["create"]) {
              a["create"] = stamp(a["create"] as object, ctx.tenantId);
            }
          }
        } else if (cls === "tenantRoot") {
          // Tenant root scopes on id, not tenantId
          if (READ_OPS.has(operation) || UNIQUE_OPS.has(operation) || operation === "update") {
            a.where = { ...a.where, id: ctx.tenantId } as AnyArgs["where"];
          }
        }
        // global models: untouched — auth runs before tenant context exists

        return query(a as never);
      },
    },
  },
});
