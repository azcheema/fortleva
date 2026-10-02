/**
 * The browser's side of `POST /api/vault/[id]/reveal | copy | totp`
 * (`src/app/api/vault/respond.ts`). One function, so every control reads
 * the edge's answers the same way:
 *
 *   - `{ ok: true, value }` — the service's answer;
 *   - `{ ok: false, error }` — the edge's refusal CODE (`MFA_REQUIRED` with
 *     its remedy, `REVEAL_BUDGET_EXCEEDED`, …); `SIGNED_OUT` when the request
 *     was REDIRECTED (a session that ended is sent to the sign-in page,
 *     which `fetch` follows); `SERVER` for any other answer that is not
 *     the edge's JSON (a framework 500 is not a signed-out member — slice
 *     85's code review); `NETWORK` when nothing came back.
 *
 * Never cached, never retried: a reveal is an audited act, and a retry
 * would be a second one.
 */

export type VaultCallKind = "reveal" | "copy" | "totp";

export type VaultRefusalCode =
  | "MFA_REQUIRED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "REVEAL_BUDGET_EXCEEDED"
  | "VAULT_BUSY"
  | "INVALID_INPUT"
  | "CROSS_SITE"
  | "SIGNED_OUT"
  | "SERVER"
  | "NETWORK";

export type VaultAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: VaultRefusalCode };

const KNOWN = new Set<string>([
  "MFA_REQUIRED",
  "NOT_FOUND",
  "FORBIDDEN",
  "REVEAL_BUDGET_EXCEEDED",
  "VAULT_BUSY",
  "INVALID_INPUT",
  "CROSS_SITE",
]);

export async function vaultCall<T>(credentialId: string, kind: VaultCallKind, field?: string): Promise<VaultAnswer<T>> {
  let res: Response;
  try {
    res = await fetch(`/api/vault/${encodeURIComponent(credentialId)}/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(field === undefined ? {} : { body: JSON.stringify({ field }) }),
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, error: "NETWORK" };
  }
  if (res.redirected) return { ok: false, error: "SIGNED_OUT" };
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return { ok: false, error: "SERVER" };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "SERVER" };
  }
  if (res.ok) return { ok: true, value: body as T };
  const code = (body as { error?: unknown } | null)?.error;
  return { ok: false, error: typeof code === "string" && KNOWN.has(code) ? (code as VaultRefusalCode) : "SERVER" };
}

/** A refusal carried through a promise — so a copy's promised value can reject with the code. */
export class VaultRefusal extends Error {
  constructor(readonly code: VaultRefusalCode) {
    super(code);
    this.name = "VaultRefusal";
  }
}
