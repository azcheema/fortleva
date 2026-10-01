import type { PrismaClient } from "@/generated/prisma/client";

import { AUDIT_EVENTS } from "@/audit/catalog";

import { assertKeyringUnwraps, mintFirstTenantKey } from "./tenant-key-material";

/**
 * THE TENANT-KEY BACK-FILL (PLAN.md Phase 3V's first line; SECURITY.md
 * §6.1: "back-filled for existing tenants before 3V ships").
 *
 * A tenant's key is otherwise minted lazily, on its first v2 encrypt
 * (`getActiveTenantDek`), by the running application — which is correct
 * on its own: no ciphertext can exist before its key, and the runtime is
 * the one process certain to hold the deployment's root keyring. The
 * back-fill gives the tenants that have never encrypted anything a key
 * too, so the keyring restore drill and a later re-wrap see every tenant.
 *
 * IT MINTS ONLY UNDER A ROOT KEY IT HAS PROVED IS THE DEPLOYMENT'S. It is
 * run from an operator's shell (`prisma/seed.ts`, opt-in with
 * `TENANT_KEY_BACKFILL=1` — RUNBOOK), and a shell can hold the wrong
 * keyring — a developer's `.env.local` against the production database
 * is the obvious way. A key wrapped under the wrong root key is an outage
 * the lazy path never repairs (it finds an ACTIVE row and stops). So the
 * newest existing tenant keys — written by the application — must unwrap
 * under this process's keyring, and when the database holds NONE there is
 * nothing to prove against and it REFUSES: let the application mint the
 * first key (any first credential or cost rate), then run it again. The
 * proof counts only keys wrapped under this process's ACTIVE root key id
 * — the one a mint would use — so a shell mid-rotation cannot pass it
 * on the strength of its PREVIOUS key (`assertKeyringUnwraps`).
 * (Three review rounds, 2026-10-01, found edge after edge in the
 * alternative — confirming a printed key fingerprint, reading the key
 * from the shell only — and this rule has none of them: a key is minted
 * only if the deployment's own ciphertext already decrypts with it.)
 *
 * It runs under the owner connection with no tenant transaction — hence
 * a raw client, a dependency-free key mint, and an audit row written
 * directly (actor SYSTEM, `tenant_key.created`, key ids only), the
 * template propagation's shape. Idempotent: a tenant that already holds
 * an ACTIVE key is skipped, and the insert races the lazy path on
 * `@@unique([tenantId, keyId])` with ON CONFLICT DO NOTHING, so neither
 * can mint a second first key; the audit row is written only by the
 * writer whose insert landed.
 *
 * `tenantIds` narrows the pass and `sampleTenantIds` the proof — a dbtest
 * must never touch a tenant it did not provision (AGENTS.md), and on the
 * shared dev database another run's keys may sit under another root key.
 * For both, an EMPTY list matches nothing and an absent one everything.
 */

export type BackfillDb = Pick<PrismaClient, "tenant" | "tenantKey" | "auditEvent" | "$transaction">;

export type BackfillResult = {
  readonly scanned: number;
  readonly created: number;
  /** "verified": the proof ran and held. "none": no tenant needed a key. */
  readonly keyring: "verified" | "none";
};

/** How many of the newest existing keys must unwrap before any is minted. */
const PROOF_SAMPLE = 3;

export async function backfillTenantKeys(
  db: BackfillDb,
  opts: { readonly tenantIds?: readonly string[]; readonly sampleTenantIds?: readonly string[] } = {},
): Promise<BackfillResult> {
  // An empty list would be `in: []`, which matches nothing — but an
  // `undefined` filter is DROPPED by Prisma and would match every tenant
  // (the 2026-08-31 incident), so the two are told apart explicitly.
  const where = opts.tenantIds === undefined ? {} : { id: { in: [...opts.tenantIds] } };
  const tenants = await db.tenant.findMany({
    where: { ...where, keys: { none: { status: "ACTIVE" } } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  if (tenants.length === 0) return { scanned: 0, created: 0, keyring: "none" };

  const sampleWhere = opts.sampleTenantIds === undefined ? {} : { tenantId: { in: [...opts.sampleTenantIds] } };
  const existing = await db.tenantKey.findMany({
    where: sampleWhere,
    orderBy: { createdAt: "desc" },
    take: PROOF_SAMPLE,
    select: { wrappedDek: true },
  });
  if (existing.length === 0) {
    throw new Error(
      "tenant-key: no existing tenant key to prove this process's root keyring against — let the application mint the first key (any first credential or cost rate), then run the back-fill again",
    );
  }
  assertKeyringUnwraps(existing.map((k) => k.wrappedDek));
  const visibility = AUDIT_EVENTS["tenant_key.created"].visibility;

  let created = 0;
  for (const { id: tenantId } of tenants) {
    const minted = mintFirstTenantKey();
    await db.$transaction(async (tx) => {
      const inserted = await tx.tenantKey.createMany({
        data: [{ tenantId, ...minted, status: "ACTIVE" }],
        skipDuplicates: true,
      });
      if (inserted.count !== 1) return;
      const row = await tx.tenantKey.findFirstOrThrow({
        where: { tenantId, keyId: minted.keyId },
        select: { id: true },
      });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: "SYSTEM",
          action: "tenant_key.created",
          targetType: "TenantKey",
          targetId: row.id,
          metadata: { keyId: minted.keyId, rootKeyId: minted.rootKeyId, reason: "backfill" },
          visibility,
        },
      });
      created += 1;
    });
  }
  return { scanned: tenants.length, created, keyring: "verified" };
}
