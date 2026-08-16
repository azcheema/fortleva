"use client";

import { useActionState } from "react";

import { verifyStepUpAction, type StepUpFormState } from "./actions";

export function StepUpForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<StepUpFormState, FormData>(
    verifyStepUpAction,
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <label className="flex flex-col gap-1 text-sm">
        Authenticator code (or a backup code)
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={32}
          required
          autoFocus
          className="rounded border border-neutral-300 px-3 py-2 text-center text-lg tracking-widest"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
      >
        {pending ? "Verifying…" : "Verify"}
      </button>
      {state && !state.ok ? <p className="text-sm text-red-600">{state.message}</p> : null}
    </form>
  );
}
