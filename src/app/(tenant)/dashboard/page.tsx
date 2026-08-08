import { requireMemberSession } from "@/auth/session";
import { listMembershipsForUser } from "@/members/service";

export default async function DashboardPage() {
  const session = await requireMemberSession();
  const memberships = await listMembershipsForUser(session.user.id);

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">Welcome, {session.user.name}</h1>
      <section className="mt-8">
        <h2 className="text-lg font-medium">Your workspaces</h2>
        {memberships.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600">
            You are not a member of any workspace yet. Ask an admin for an
            invitation.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {memberships.map((m) => (
              <li
                key={m.memberId}
                className="rounded border border-neutral-200 px-4 py-3"
              >
                <span className="font-medium">{m.tenantName}</span>
                <span className="ml-2 text-sm text-neutral-500">
                  {m.status === "SUSPENDED" ? "suspended" : "active"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
