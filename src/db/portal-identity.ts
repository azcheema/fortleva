import { runtimeClient } from "./client";
import {
  assertWritable,
  ID_GUC,
  EMAIL_GUC,
  keysOf,
  PortalIdentityRefused,
  type ContactAuthKeys,
} from "./portal-identity-policy";
import { txOptions, withTenant } from "./with-tenant";

export { PortalIdentityRefused } from "./portal-identity-policy";

/**
 * The portal auth path's reach into `contact` — a FIFTH narrow entry
 * point beside withTenant / withPlatform / withUser /
 * recordPlatformEvent, and narrow for the same reason they are.
 *
 * WHY THIS FILE HAS TO EXIST. The portal Better Auth instance maps
 * Better Auth's `user` model onto `Contact` (DATA_MODEL.md §6.4). But
 * `contact` is a tenant-scoped class-B table, and its `tenant_isolation`
 * policy reads `tenant_id = app.tenant_id` — a GUC that cannot be set
 * at sign-in, because the tenant is precisely what the lookup is trying
 * to discover. With it unset the comparison is NULL and the auth path
 * reads ZERO rows, so no contact could ever sign in. The member plane
 * never meets this: its `user` table is global and carries a blanket
 * `allow_runtime USING (true)`.
 *
 * WHAT IT DOES INSTEAD, and what it deliberately does NOT do. It does
 * not open a BYPASSRLS connection — putting `app_platform` behind an
 * unauthenticated endpoint would be the worst trade in the product.
 * It is the `withUser()` pattern (migration
 * 20260808200000_member_self_visibility): a transaction-local GUC
 * naming the exact row the request already identified, and an RLS
 * policy that admits that row and nothing else. RLS remains the whole
 * gate; this file only tells it which row was asked for.
 *
 * READ THE POLICIES WITH THIS FILE — migration
 * 20260920210000_phase3_contact_identity. In particular: there is no
 * INSERT policy for the auth path, so invite-only is a property of the
 * DATABASE and not merely of `disableSignUp`. And `portalStatus`,
 * `portalProfile`, `tenantId` and `clientId` are immutable here by
 * trigger, so invite ACCEPTANCE (which flips portalStatus to ACTIVE)
 * is a brokered tenant-path write, never something the auth plane can
 * do to itself.
 */

type Args = { where?: unknown; data?: unknown } & Record<string, unknown>;

/**
 * One unit of work on the auth path. Both GUCs are always emitted —
 * the absent one as the empty string rather than left unset — so a
 * value can never be inherited from whatever ran before on this pooled
 * connection, and `''` matches neither an id nor an address.
 * `is_local = true` for the same reason it is load-bearing in
 * withTenant(): Neon's pooler is PgBouncer in transaction mode.
 */
const withContactAuth = async <T>(
  keys: ContactAuthKeys,
  fn: (tx: typeof runtimeClient) => Promise<T>,
): Promise<T> =>
  runtimeClient.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT set_config(${EMAIL_GUC}, ${keys.email ?? ""}, true),
               set_config(${ID_GUC}, ${keys.id ?? ""}, true)`;
      return fn(tx as unknown as typeof runtimeClient);
    },
    // The product's tuned budget, NOT Prisma's hardcoded 5 s. Every
    // other transaction here scales by LINK_FACTOR precisely because
    // 5 s is too tight across the Neon link — the run that gated this
    // slice had two transactions exceed it by ~400 ms. Sign-in is the
    // one transaction a user cannot retry around, so it is the last
    // place that should quietly keep the untuned default (review).
    txOptions(),
  );

/**
 * A WRITE is not a read with a different verb, and this is the part of
 * the file worth reading twice.
 *
 * `contact` carries an AFTER INSERT/UPDATE/DELETE trigger that feeds
 * `search_index`, whose own RLS is the ordinary `tenant_id =
 * app.tenant_id`. The first version of this seam gave the auth path an
 * UPDATE policy, and every write then FAILED with `42501 new row
 * violates row-level security policy for table "search_index"` — which
 * is how the problem was found. Any "just let the auth path write"
 * policy would have had to widen the search index to an unauthenticated
 * plane to work at all.
 *
 * Stated in the past tense deliberately (review): with the UPDATE
 * policy gone, a tenant-less update no longer reaches that trigger at
 * all — it matches zero rows and dies on `contact`. The search feed is
 * the REASON for what follows, not its current failure mode.
 *
 * The write therefore runs where a write to a tenant row belongs: in
 * that tenant's own context, through `withTenant` as the SYSTEM
 * principal — the same brokered-write seam AUTHZ.md §8 already
 * mandates for every contact-caused write. Two narrowings ride along:
 *   - the tenant is not supplied by the caller. It is read back off
 *     the row the auth GUC admitted, so a write can only ever land in
 *     the tenancy the lookup already proved;
 *   - `app.auth_contact_id` is set INSIDE that transaction, which is
 *     what keeps the immutability trigger live (migration
 *     20260920210000). Tenancy, client, profile and status stay
 *     immutable even though the transaction is now a system one.
 */
const authPathUpdate = async (args: Args, many: boolean): Promise<unknown> => {
  assertWritable(args.data);
  const keys = keysOf(args);
  if (!keys.id) {
    throw new PortalIdentityRefused("the auth path may only update a contact named by id");
  }
  const row = await withContactAuth(keys, (tx) =>
    tx.contact.findFirst({ where: { id: keys.id }, select: { id: true, tenantId: true } }),
  );
  if (!row) return many ? { count: 0 } : null;
  return withTenant(row.tenantId, { type: "system" }, async (tx) => {
    await tx.$queryRaw`SELECT set_config(${ID_GUC}, ${row.id}, true)`;
    // BOTH branches are intersected with the id the lookup actually
    // admitted. This transaction has the whole tenant in reach, so a
    // `where` that matched anything other than that one row would let
    // the auth path rewrite a SIBLING contact's identity columns.
    //
    // `update` was originally left alone, on the reasoning that Prisma
    // requires a unique `where` there so it already names one row. That
    // is WRONG, and the review caught it: `ContactWhereUniqueInput`
    // accepts `AND`/`OR`/`NOT` ALONGSIDE the unique field, and the
    // adapter emits exactly that shape — `convertWhereClause`'s update
    // branch writes the simple equalities as bare keys and then adds
    // `result.OR`. So `{ email: V, OR: [{id: X}, {name: n}] }` passes
    // the `keys.id` guard above via X while the row actually written is
    // whichever contact of that tenant satisfies the whole predicate.
    // Better Auth does not build such a where today; the intersection is
    // what makes that a fact about this code rather than about theirs.
    const where = { AND: [(args.where ?? {}) as object, { id: row.id }] };
    if (!many) {
      // `update` needs a UNIQUE where, so the id stays the top-level
      // key and the caller's own predicate rides along in the AND.
      return tx.contact.update({
        ...(args as Record<string, unknown>),
        where: { id: row.id, ...where },
      } as never);
    }
    return tx.contact.updateMany({ ...(args as Record<string, unknown>), where } as never);
  });
};

/**
 * The `contact` delegate handed to the Prisma adapter in place of the
 * real one. Only the operations the portal instance performs are
 * implemented; `create` and the deletes are refused outright, because a
 * contact is created and destroyed on the tenant path under
 * `client:manage_contacts` and nowhere else.
 */
const contactAuthDelegate = {
  findFirst: (args: Args) =>
    withContactAuth(keysOf(args), (tx) => tx.contact.findFirst(args as never)),
  findMany: (args: Args) =>
    withContactAuth(keysOf(args), (tx) => tx.contact.findMany(args as never)),
  count: (args: Args) => withContactAuth(keysOf(args), (tx) => tx.contact.count(args as never)),
  update: (args: Args) => authPathUpdate(args, false),
  updateMany: (args: Args) => authPathUpdate(args, true),
  // Every refusal is a REJECTED PROMISE, not a synchronous throw. The
  // adapter awaits these, so both propagate — but a surface that throws
  // one way for some inputs and another way for others is a trap for
  // the next caller, and `create` is the one most likely to acquire one.
  create: async (): Promise<never> => {
    throw new PortalIdentityRefused(
      "contacts are created on the tenant path (client:manage_contacts); the portal is invite-only",
    );
  },
  delete: async (): Promise<never> => {
    throw new PortalIdentityRefused("the auth path may not delete a contact");
  },
  deleteMany: async (): Promise<never> => {
    throw new PortalIdentityRefused("the auth path may not delete a contact");
  },
};

/**
 * The client the portal Better Auth instance is built on. Deliberately
 * an explicit four-model object rather than a Proxy over the real
 * client: what the portal auth plane can touch should be readable in
 * one glance, and a model that is not listed is absent rather than
 * quietly reachable.
 *
 * `$transaction` is intentionally NOT exposed. The Prisma adapter only
 * consults it in the `deleteOne`/`incrementOne` fallbacks for a where
 * without an id, neither of which this instance performs, and it
 * degrades to a non-transactional claim when the method is missing
 * (`typeof db.$transaction !== "function"`). Exposing the real one
 * would hand out a transaction whose `tx.contact` is the RAW delegate,
 * with no GUCs and therefore no rows — a silent zero instead of an
 * honest absence.
 */
export const portalAuthClient = {
  contact: contactAuthDelegate,
  contactSession: runtimeClient.contactSession,
  contactAccount: runtimeClient.contactAccount,
  contactVerification: runtimeClient.contactVerification,
};
