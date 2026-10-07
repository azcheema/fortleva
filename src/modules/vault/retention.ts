import { recordMany } from "@/audit/record";
import { withTenant, type TenantDb } from "@/db";

import { boundedVaultWrite } from "./ctx";
import { eraseSecretsOf } from "./secret-store";

/**
 * THE VAULT'S RETENTION (Phase 3V slice 99; DATA_MODEL.md §5 R2; founder
 * decision C67 (a), (f)) — what the daily job (`src/jobs/vault-retention.ts`)
 * does for one tenant, as the SYSTEM principal:
 *
 * 1. THE BIN. A deleted login sits in the bin for `BIN_DAYS` (no restore
 *    exists; the bin is the window R2 names). After that its secret is
 *    erased for good, and its row:
 *      - is DELETED when nobody sent it and none of its share links' records
 *        is still within its `SHARE_LINK_KEPT_MONTHS` — its secret, previous
 *        versions and (old) links go with it by the FKs' cascade; its search
 *        row went when it was binned;
 *      - otherwise becomes a TOMBSTONE: its secret and versions are erased
 *        (`eraseSecretsOf`, the one file that touches those tables) and
 *        everything else on it is emptied, but the row stays —
 *          · a login a client's contact SENT (slice 96) keeps the client's
 *            record of it for good: their name for it and the date (the
 *            submission broker's list shows exactly those; `deleteContact`
 *            counts it as the contact's writing). C67 (a);
 *          · a login nobody sent keeps its own name, client and dates only
 *            while one of its share links' records is within its 12 months,
 *            so those records still say which login went to which address —
 *            the link row is the only place the address is kept, the audit
 *            never carries it. C67 (f), asked after the security review.
 *    One `credential.purged` audit row per login erased (`kept: "sent"` or
 *    `kept: "links"` for a tombstone).
 *
 * 2. THE SHARE LINKS' RECORDS. A link row is kept `SHARE_LINK_KEPT_MONTHS`
 *    after it expired (every link ends by `expires_at` at the latest — a
 *    view or a revoke comes before it), then deleted. NOT audited: the
 *    evidence is the audit trail of the link's life (`credential.shared`
 *    … `share_viewed`), which outlives the row on its own schedule; a
 *    record leaving on its retention date is nobody's act — the renewal
 *    reminders' dedupe sweep is the precedent (`reminders.ts`).
 *
 * 3. TOMBSTONES KEPT FOR THEIR LINKS, RELEASED. A tombstone nobody sent is
 *    deleted once none of its links' records is within its 12 months (the
 *    cascade takes the old ones). Not audited either: its erasure was, in
 *    1; what leaves here is a name kept as evidence, on its date.
 *
 * The database holds each rule (migrations 20261007220000 and
 * 20261007230000): only the SYSTEM principal deletes a login, only one
 * binned `BIN_DAYS` that nobody sent, and only once none of its links is
 * within its months (`credential_item_delete_guard` — a login's DELETE
 * cascades to its links, so that is where the months are held); a
 * tombstone is made only by it, of a login binned as long, keeps its record
 * as it was, holds nothing else (`credential_item_purged_shape`) and never
 * changes again (`credential_item_purge_guard`); a link's record goes only
 * on its date or with its login (`credential_share_link_delete_guard`).
 *
 * Every rule is measured on the DATABASE's clock (`now()`, the one the
 * guards use), never the job's. Batches of `LOGIN_BATCH` logins and
 * `LINK_BATCH` links per transaction, at most `MAX_BATCHES` of each per
 * run; a row another transaction holds is skipped, never waited on
 * (`SKIP LOCKED` — a concurrent run, or a member's removal flagging a
 * binned login), and taken by the next run. A second run at the same time
 * therefore never writes a second audit row for a login. Runs whether or
 * not the vault module is switched on: an erasure must not pause because a
 * module did. Nothing here logs; nothing here reads a secret.
 *
 * The one caller is the job (`vault-boundary.test.ts` pins it): this has no
 * gate of its own, and nothing a person does should reach it.
 */

/** How long a deleted login waits in the bin before it is erased (R2). */
export const BIN_DAYS = 30;
/** How long a share link's record is kept after it expired (R2). */
export const SHARE_LINK_KEPT_MONTHS = 12;

const LOGIN_BATCH = 100;
const LINK_BATCH = 500;
const MAX_BATCHES = 10;

export type RetentionRun = {
  /** Logins deleted outright, with everything of theirs. */
  readonly deleted: number;
  /** Logins erased but kept as tombstones — the client's record, or their links' evidence. */
  readonly kept: number;
  /** Tombstones nobody sent, deleted once their links' records were all past their months. */
  readonly released: number;
  /** Share links' records past their twelve months. */
  readonly links: number;
};

type Picked = {
  readonly id: string;
  readonly client_id: string | null;
  readonly project_id: string | null;
  readonly submitted: boolean;
  readonly linked: boolean;
};

/**
 * One batch of the bin: the oldest logins past `BIN_DAYS`, locked (skipping
 * any another transaction holds), then deleted or made tombstones.
 */
async function purgeBinBatch(tx: TenantDb, tenantId: string): Promise<{ deleted: number; kept: number; picked: number }> {
  // `linked`: a share link of it whose record is still within its months —
  // on the same clock and bound `credential_item_delete_guard` uses. No new
  // link can appear on a binned login (making one takes the login FOR SHARE
  // and refuses a binned one), so the answer holds for this transaction.
  const picked = await tx.$queryRaw<Picked[]>`
    SELECT c.id, c.client_id, c.project_id,
           (c.submitted_by_contact_id IS NOT NULL) AS submitted,
           EXISTS (SELECT 1 FROM credential_share_link l
                    WHERE l.tenant_id = c.tenant_id AND l.credential_id = c.id
                      AND l.expires_at >= now() - make_interval(months => ${SHARE_LINK_KEPT_MONTHS}::int)) AS linked
      FROM credential_item c
     WHERE c.tenant_id = ${tenantId}
       AND c.deleted_at IS NOT NULL
       AND c.deleted_at <= now() - make_interval(days => ${BIN_DAYS}::int)
       AND c.purged_at IS NULL
     ORDER BY c.deleted_at, c.id
     LIMIT ${LOGIN_BATCH}
     FOR UPDATE OF c SKIP LOCKED`;
  if (picked.length === 0) return { deleted: 0, kept: 0, picked: 0 };

  const gone = picked.filter((p) => !p.submitted && !p.linked).map((p) => p.id);
  const keep = picked.filter((p) => p.submitted || p.linked).map((p) => p.id);

  // Nobody sent it and no link's record needs it: the row goes, and its
  // secret, versions and (old) links with it.
  const deleted =
    gone.length === 0
      ? []
      : await tx.$queryRaw<{ id: string }[]>`
          DELETE FROM credential_item
           WHERE tenant_id = ${tenantId} AND id = ANY(${gone}::text[])
          RETURNING id`;

  // Kept: the secret goes, the record stays. A sent login is named as it was
  // SENT (the team's rename goes); one nobody sent keeps its own name. The
  // stamp is the statement's own moment, the one the purge guard measures.
  // Visibility and seal are SET too, though a binned login is INTERNAL and
  // unsealed already: the tombstone's shape CHECK needs both, and a row
  // binned some other way (a platform connection) must not stop this
  // tenant's purge for good — it would come first in every run (the
  // migration review's low).
  const kept =
    keep.length === 0
      ? []
      : await tx.$queryRaw<{ id: string }[]>`
          UPDATE credential_item
             SET purged_at = statement_timestamp(),
                 visibility = 'INTERNAL', sealed_at = NULL,
                 name = CASE WHEN submitted_by_contact_id IS NULL THEN name ELSE submitted_name END,
                 username = NULL, url = NULL, notes = NULL,
                 tags = '{}', secret_field_keys = '{}', has_totp = false,
                 expires_at = NULL, rotate_every_days = NULL, last_rotated_at = NULL,
                 needs_rotation = false, compromised_at = NULL,
                 project_id = NULL, archived_at = NULL, updated_by_member_id = NULL,
                 updated_at = statement_timestamp()
           WHERE tenant_id = ${tenantId} AND id = ANY(${keep}::text[]) AND purged_at IS NULL
          RETURNING id`;
  const keptIds = kept.map((k) => k.id);
  await eraseSecretsOf(tx, tenantId, keptIds);

  const byId = new Map(picked.map((p) => [p.id, p]));
  const rows = [
    ...deleted.map((d) => ({ id: d.id, kept: null as "sent" | "links" | null })),
    ...keptIds.map((id) => ({ id, kept: byId.get(id)?.submitted ? ("sent" as const) : ("links" as const) })),
  ].flatMap(({ id, kept: why }) => {
    const p = byId.get(id);
    if (!p) return [];
    return [
      {
        action: "credential.purged" as const,
        targetType: "CredentialItem",
        targetId: id,
        metadata: { clientId: p.client_id, projectId: p.project_id, ...(why ? { kept: why } : {}) },
      },
    ];
  });
  if (rows.length > 0) await recordMany(tx, rows);
  return { deleted: deleted.length, kept: keptIds.length, picked: picked.length };
}

/** One batch of tombstones nobody sent whose links' records are all past their months. */
async function releaseBatch(tx: TenantDb, tenantId: string): Promise<number> {
  return tx.$executeRaw`
    DELETE FROM credential_item
     WHERE tenant_id = ${tenantId}
       AND id IN (SELECT c.id FROM credential_item c
                   WHERE c.tenant_id = ${tenantId}
                     AND c.purged_at IS NOT NULL AND c.submitted_by_contact_id IS NULL
                     AND c.deleted_at <= now() - make_interval(days => ${BIN_DAYS}::int)
                     AND NOT EXISTS (SELECT 1 FROM credential_share_link l
                                      WHERE l.tenant_id = c.tenant_id AND l.credential_id = c.id
                                        AND l.expires_at >= now() - make_interval(months => ${SHARE_LINK_KEPT_MONTHS}::int))
                   ORDER BY c.purged_at, c.id
                   LIMIT ${LOGIN_BATCH}
                   FOR UPDATE OF c SKIP LOCKED)`;
}

/** One batch of share links' records past their twelve months. */
async function sweepLinkBatch(tx: TenantDb, tenantId: string): Promise<number> {
  return tx.$executeRaw`
    DELETE FROM credential_share_link
     WHERE tenant_id = ${tenantId}
       AND id IN (SELECT id FROM credential_share_link
                   WHERE tenant_id = ${tenantId}
                     AND expires_at < now() - make_interval(months => ${SHARE_LINK_KEPT_MONTHS}::int)
                   ORDER BY expires_at, id
                   LIMIT ${LINK_BATCH}
                   FOR UPDATE SKIP LOCKED)`;
}

/** Run one phase in batches until a batch comes back short; each batch its own bounded transaction. */
async function inBatches(tenantId: string, size: number, batch: (tx: TenantDb) => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const n = await boundedVaultWrite((opts) => withTenant(tenantId, { type: "system" }, batch, opts));
    total += n;
    if (n < size) break;
  }
  return total;
}

/**
 * The bin, the kept tombstones and the share links' records of ONE tenant —
 * see the file's comment. Each batch is its own transaction with a bounded
 * lock wait (`boundedVaultWrite`: a cascade may wait on a share page holding
 * a link). The three phases are independent: one that fails (and is
 * reported by the job) does not stop the others; the first failure is
 * thrown once all three have run.
 */
export async function purgeVaultRetention(tenantId: string): Promise<RetentionRun> {
  let deleted = 0;
  let kept = 0;
  const failures: unknown[] = [];
  const attempt = async (phase: () => Promise<void>) => {
    try {
      await phase();
    } catch (e) {
      failures.push(e);
    }
  };

  await attempt(async () => {
    for (let i = 0; i < MAX_BATCHES; i += 1) {
      const batch = await boundedVaultWrite((opts) =>
        withTenant(tenantId, { type: "system" }, (tx) => purgeBinBatch(tx, tenantId), opts),
      );
      deleted += batch.deleted;
      kept += batch.kept;
      if (batch.picked < LOGIN_BATCH) break;
    }
  });
  let released = 0;
  await attempt(async () => {
    released = await inBatches(tenantId, LOGIN_BATCH, (tx) => releaseBatch(tx, tenantId));
  });
  let links = 0;
  await attempt(async () => {
    links = await inBatches(tenantId, LINK_BATCH, (tx) => sweepLinkBatch(tx, tenantId));
  });
  if (failures.length > 0) throw failures[0];
  return { deleted, kept, released, links };
}
