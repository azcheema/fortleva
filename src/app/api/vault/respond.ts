import { z } from "zod";

import { AuthzError } from "@/authz/errors";
import { DomainError } from "@/lib/domain-error";
import { requireTenantContext } from "@/members/tenant-context";
import type { VaultCtx } from "@/modules/vault";

/**
 * The vault's HTTP edge (plan §3.4: `POST /api/vault/[id]/reveal | copy |
 * totp`). Each route is one call into the gated services of
 * `@/modules/vault` — which own every check that matters: the permission,
 * the scope, the vault window and the reveal budget, each refusal recorded
 * where the service records it. This file adds only what an HTTP edge must:
 *
 *   - **SAME-ORIGIN ONLY.** The member cookie is SameSite=Lax, which stops
 *     a cross-SITE post but not a same-site one: any page on a sibling
 *     subdomain could fire `fetch(…, { credentials: "include" })` here and,
 *     while it could never read the answer, it would spend the member's
 *     reveal budget and write `credential.revealed` rows in their name. Our
 *     own page's `fetch` is `same-origin`, and every current browser sends
 *     `Sec-Fetch-Site` on a fetch — so anything else, a missing header
 *     included, is refused before a session is even read. (Stricter than
 *     the download routes' `crossSiteRefusal`, which lets a missing header
 *     through: a refused download is a nuisance, a refused reveal is the
 *     vault failing closed.)
 *   - **NO-STORE on every answer**, success or refusal: a plaintext must
 *     never sit in a browser or proxy cache (the service worker is
 *     network-only for `/api/*` as well — ARC-25).
 *   - **A BOUNDED, SHAPED BODY**: at most 512 bytes of JSON — a larger
 *     declared length is refused before a byte is read, and the stream is
 *     read against the cap, never buffered whole first (slice 85's code
 *     review) — an object, a field name of at most 64 characters; refused
 *     with a word, never echoed.
 *   - **REFUSALS AS CODES**, never the error's message: the client
 *     translates `{ error }` itself, and MFA_REQUIRED carries its remedy so
 *     the page can turn into the door.
 */

const NO_STORE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } as const;
const BODY_MAX = 512;
const FIELD_MAX = 64;
const uuid = z.uuid();

export type VaultRefusal =
  | "CROSS_SITE"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "MFA_REQUIRED"
  | "REVEAL_BUDGET_EXCEEDED"
  | "VAULT_BUSY";

export const vaultJson = (body: unknown, status = 200): Response => Response.json(body, { status, headers: NO_STORE });

const refuse = (error: VaultRefusal, status: number, extra: Record<string, string> = {}): Response =>
  vaultJson({ error, ...extra }, status);

/**
 * A service refusal as an HTTP answer. Anything that is neither an
 * `AuthzError` nor a `DomainError` is a real failure and propagates — the
 * framework answers 500 without a body we wrote.
 */
export function vaultFailure(e: unknown): Response {
  if (e instanceof AuthzError) {
    if (e.reason === "MFA_REQUIRED") return refuse("MFA_REQUIRED", 401, { remedy: e.mfaRemedy ?? "step_up" });
    if (e.reason === "NOT_FOUND") return refuse("NOT_FOUND", 404);
    return refuse("FORBIDDEN", 403);
  }
  if (e instanceof DomainError) {
    if (e.code === "REVEAL_BUDGET_EXCEEDED") return refuse("REVEAL_BUDGET_EXCEEDED", 429);
    if (e.code === "VAULT_BUSY") return refuse("VAULT_BUSY", 503);
    return refuse("INVALID_INPUT", 400);
  }
  throw e;
}

/** The body as text, read against BODY_MAX bytes — or null when it is larger. */
async function readCapped(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BODY_MAX) return null;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_MAX) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** The request's body: `{}` when empty, an object, or a refusal. */
async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await readCapped(request);
  if (text === null) return refuse("INVALID_INPUT", 400);
  if (text.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("INVALID_INPUT", 400);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return refuse("INVALID_INPUT", 400);
  return parsed as Record<string, unknown>;
}

/** The `field` a reveal or copy names — a short non-empty string, or null. */
export const fieldOf = (body: Record<string, unknown>): string | null => {
  const v = body["field"];
  return typeof v === "string" && v.length > 0 && v.length <= FIELD_MAX ? v : null;
};

/**
 * One vault POST: origin, id, body — and, for a reveal or a copy, the field
 * — all refused before a session is read; then the session (a missing one
 * redirects to sign-in, as everywhere) and the service call, whose answer
 * is sent as JSON with no-store.
 */
async function handle(
  request: Request,
  params: Promise<{ id: string }>,
  wantsField: boolean,
  act: (ctx: VaultCtx, id: string, field: string | null) => Promise<unknown>,
): Promise<Response> {
  if (request.headers.get("sec-fetch-site") !== "same-origin") return refuse("CROSS_SITE", 403);
  const { id } = await params;
  if (!uuid.safeParse(id).success) return refuse("NOT_FOUND", 404);
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const field = fieldOf(body);
  if (wantsField && field === null) return refuse("INVALID_INPUT", 400);
  const { membership, actor } = await requireTenantContext();
  try {
    return vaultJson(await act({ tenantId: membership.tenantId, actor }, id, field));
  } catch (e) {
    return vaultFailure(e);
  }
}

/** A POST that names one secret field (reveal, copy). */
export const vaultFieldPost = (
  request: Request,
  params: Promise<{ id: string }>,
  act: (ctx: VaultCtx, id: string, field: string) => Promise<unknown>,
): Promise<Response> => handle(request, params, true, (ctx, id, field) => act(ctx, id, field as string));

/** A POST about the credential as a whole (the TOTP code). */
export const vaultPost = (
  request: Request,
  params: Promise<{ id: string }>,
  act: (ctx: VaultCtx, id: string) => Promise<unknown>,
): Promise<Response> => handle(request, params, false, (ctx, id) => act(ctx, id));
