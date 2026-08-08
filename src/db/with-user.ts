import { runtimeClient } from "./client";
import { isUuid } from "./context";

/**
 * Identity-scoped unit of work: sets ONLY app.user_id
 * (transaction-locally, same pooler rules as withTenant §4.2) so the
 * session layer can list the caller's own memberships and their tenant
 * rows via the member_self_select / tenant_member_select policies.
 * No tenant context, no where-injection — RLS is the whole gate here.
 */
export type UserDb = Pick<typeof runtimeClient, "member" | "tenant" | "user">;

export async function withUser<T>(
  userId: string,
  fn: (tx: UserDb) => Promise<T>,
): Promise<T> {
  if (!isUuid(userId)) throw new Error("withUser: userId is not a UUID");
  return runtimeClient.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    return fn(tx as unknown as UserDb);
  });
}
