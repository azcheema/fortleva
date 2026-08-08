"use client";

import { useActionState } from "react";

import { inviteMemberAction, type InviteFormState } from "./actions";

export function InviteForm({ roles }: { roles: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<InviteFormState, FormData>(
    inviteMemberAction,
    null,
  );

  return (
    <form action={action} className="mt-3 flex max-w-md flex-col gap-3">
      <input
        type="email"
        name="email"
        required
        placeholder="colleague@company.com"
        className="rounded border border-neutral-300 px-3 py-2"
      />
      <fieldset className="flex flex-wrap gap-3 text-sm">
        {roles.map((r) => (
          <label key={r.id} className="flex items-center gap-1">
            <input type="checkbox" name="roleIds" value={r.id} />
            {r.name}
          </label>
        ))}
      </fieldset>
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
      >
        {pending ? "Sending…" : "Send invitation"}
      </button>
      {state ? (
        <p className={`text-sm ${state.ok ? "text-green-700" : "text-red-600"}`}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
