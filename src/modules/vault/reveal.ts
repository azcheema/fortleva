import { record } from "@/audit/record";
import { requireRecentMfa } from "@/authz/authorize";
import { AuthzError, deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { DomainError, fail } from "@/lib/domain-error";
import { readPreferences } from "@/preferences/service";
import { allow } from "@/ratelimit";

import { lockRevealBudget, revealsInLastHour } from "./budget";
import { boundedVaultWrite, idOf, principalOf, type VaultCtx } from "./ctx";
import { SECRET_FIELDS, type CredentialType } from "./fields";
import { assertCredentialInScope } from "./scope";
import { readSecret, readTotp } from "./secret-store";
import { totpCode } from "./totp";

/**
 * THE REVEAL PATH (plan §3.4; SECURITY.md §6.3; DATA_MODEL.md §6.17):
 * Reveal, Copy and a TOTP code — three separate calls, each decrypting
 * ONE thing and writing ONE audit row in the transaction that decrypted.
 *
 * THE GATES, IN THIS ORDER, and the order is the security argument:
 *   1. impersonation never reveals (AUTHZ.md §7.5: the vault refuses any
 *      session carrying an impersonator, on top of authorize()'s
 *      view-only rule);
 *   2. `credential:view` — the blanket gate, module switches included;
 *   3. the credential exists, is live, and is IN SCOPE — NOT_FOUND
 *      otherwise, so nothing after this point can tell an out-of-scope
 *      id from a missing one;
 *   4. `credential:reveal` ✦ and a second factor no older than
 *      `vault.stepUpMinutes` — a stale or missing factor is RECORDED
 *      (`vault.step_up_required`) and refused as MFA_REQUIRED, so the UI
 *      can open the step-up dialog and retry;
 *   5. the reveal budget — `vault.revealBudgetPerHour` per member per
 *      rolling hour, counted from the member's own reveal rows under a
 *      lock (`budget.ts`), fail-closed; exceeding it is RECORDED
 *      (`vault.reveal_budget_exceeded`) and refused;
 *   6. decrypt, take the one field, record, return.
 *
 * A RECORDED REFUSAL COMMITS. The two refusals in 4 and 5 are returned
 * out of the transaction rather than thrown inside it, so their audit
 * row lands and the error is raised after the commit: a probe that left
 * no trace would be invisible exactly when somebody is probing.
 *
 * Nothing here logs, and no error carries a value. The plaintext exists
 * from the decrypt to the return, and the caller (a route handler, a
 * later slice) sends it with `Cache-Control: no-store`.
 */

export type RevealKind = "reveal" | "copy";

type Item = { readonly id: string; readonly type: CredentialType; readonly hasTotp: boolean };
type Gated<T> = { readonly value: T } | { readonly refused: Error };

async function gated<T>(
  ctx: VaultCtx,
  credentialId: string,
  act: (tx: TenantDb, item: Item) => Promise<T>,
): Promise<T> {
  const id = idOf(credentialId, "credentialId");
  if (ctx.actor.impersonated) deny("FORBIDDEN", "impersonation never reveals");
  // The cheap filter in front of the authority (a no-op without Upstash —
  // `src/ratelimit`'s own note). Its limit sits above any tenant setting,
  // so the recorded refusal below is the one that normally fires.
  if (!(await allow("vault.reveal", ctx.actor.memberId))) fail("REVEAL_BUDGET_EXCEEDED", "front filter");

  // The budget lock's wait is bounded and retried, then VAULT_BUSY: a
  // statement parked on a lock ignores the transaction's timeout, so an
  // unbounded wait would pin a pooled connection per queued reveal.
  const outcome: Gated<T> = await boundedVaultWrite((opts) => withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "credential:view");
    const item = await tx.credentialItem.findFirst({
      where: { tenantId: ctx.tenantId, id, deletedAt: null },
      select: { id: true, type: true, hasTotp: true, clientId: true, projectId: true },
    });
    if (!item) return deny("NOT_FOUND");
    await assertCredentialInScope(tx, ctx.actor, item);

    const prefs = await readPreferences(tx, ctx.tenantId);
    try {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "credential:reveal");
      await requireRecentMfa(ctx.actor, prefs.vault.stepUpMinutes);
    } catch (e) {
      if (!(e instanceof AuthzError) || e.reason !== "MFA_REQUIRED") throw e;
      await record(tx, {
        action: "vault.step_up_required",
        targetType: "CredentialItem",
        targetId: item.id,
        metadata: { remedy: e.mfaRemedy ?? "step_up" },
      });
      return { refused: e };
    }

    const now = await lockRevealBudget(tx, ctx.tenantId, ctx.actor.memberId);
    const used = await revealsInLastHour(tx, ctx.tenantId, ctx.actor.memberId, now);
    const budget = prefs.vault.revealBudgetPerHour;
    if (used >= budget) {
      await record(tx, {
        action: "vault.reveal_budget_exceeded",
        targetType: "CredentialItem",
        targetId: item.id,
        metadata: { used, budget },
      });
      return { refused: new DomainError("REVEAL_BUDGET_EXCEEDED") };
    }

    return { value: await act(tx, item) };
  }, opts));
  if ("refused" in outcome) throw outcome.refused;
  return outcome.value;
}

async function revealField(ctx: VaultCtx, credentialId: string, field: string, kind: RevealKind): Promise<string> {
  if (typeof field !== "string") fail("INVALID_INPUT", "field");
  return gated(ctx, credentialId, async (tx, item) => {
    // A field name the type does not have is a caller bug; one the type
    // has but this credential does not carry is "nothing to show".
    if (!SECRET_FIELDS[item.type].includes(field)) fail("INVALID_INPUT", "field");
    const secret = await readSecret(tx, ctx.tenantId, item.id);
    const value = secret?.payload.fields[field];
    if (typeof value !== "string") fail("INVALID_INPUT", "field is not set");
    await record(tx, {
      action: kind === "reveal" ? "credential.revealed" : "credential.copied",
      targetType: "CredentialItem",
      targetId: item.id,
      metadata: { field },
    });
    return value as string;
  });
}

/** credential:reveal ✦ — show ONE secret field; audited `credential.revealed`. */
export const revealCredentialField = (ctx: VaultCtx, credentialId: string, field: string): Promise<string> =>
  revealField(ctx, credentialId, field, "reveal");

/**
 * credential:reveal ✦ — the same field for the clipboard, audited as
 * `credential.copied`. A separate call on purpose (plan §3.4): "copied"
 * and "looked at" are different acts in a trail somebody reads later.
 */
export const copyCredentialField = (ctx: VaultCtx, credentialId: string, field: string): Promise<string> =>
  revealField(ctx, credentialId, field, "copy");

/**
 * credential:reveal ✦ — the CURRENT TOTP code, generated here from the
 * stored seed (never returned), with the instant it expires so the UI can
 * count down. Audited `credential.totp_generated`.
 */
export async function generateCredentialTotp(
  ctx: VaultCtx,
  credentialId: string,
): Promise<{ readonly code: string; readonly validUntil: Date; readonly period: number }> {
  return gated(ctx, credentialId, async (tx, item) => {
    if (!item.hasTotp) fail("INVALID_INPUT", "this credential has no TOTP seed");
    const params = await readTotp(tx, ctx.tenantId, item.id);
    if (!params) fail("INVALID_INPUT", "this credential has no TOTP seed");
    const { code, validUntil } = totpCode(params!, Date.now());
    await record(tx, {
      action: "credential.totp_generated",
      targetType: "CredentialItem",
      targetId: item.id,
      metadata: {},
    });
    return { code, validUntil, period: params!.period };
  });
}
