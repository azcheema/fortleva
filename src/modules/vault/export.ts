import { recordMany } from "@/audit/record";
import { requireRecentMfa, resolveScope } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { heldAndAccessibleCodes, requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { newId } from "@/lib/ids";
import { VAULT_EXPORTED_MAIL } from "@/notify/vault-export-mail-key";

import { lockRevealBudget } from "./budget";
import { boundedVaultWrite, idOf, principalOf, type VaultCtx } from "./ctx";
import { enterVault } from "./door";
import { folderName, toBitwardenCsv, type ExportLabels, type ExportRow } from "./export-csv";
import { anchorScopeWhere } from "./scope";
import { readSecretsForExport } from "./secret-store";

/**
 * THE EXPORT (Phase 3V slice 95; AUTHZ.md §3.2's `credential:export` row;
 * SECURITY.md §6.3 "the vault is never a lock-in"; founder decision C63).
 * A member exports every login they can see — or one client's, or the
 * agency's own — with the secrets in plain text, as ONE file a password
 * manager imports (`export-csv.ts`). The file is built here and handed
 * back to the caller; it is never stored, so it exists on the server only
 * for the length of the request.
 *
 * THE GATES, IN THIS ORDER:
 *   1. the vault's door (`enterVault`): impersonation never, then
 *      `credential:view` on all four gates, then the vault's window;
 *   2. `credential:export` ✦ AND `credential:reveal` ✦ — a file of every
 *      secret is every reveal at once, which a role holding export
 *      without reveal was never granted (share's rule, `share-links.ts`);
 *   3. a factor verified within `EXPORT_STEP_UP_MINUTES` — AUTHZ.md §7.5:
 *      export ALWAYS steps up (CP4). The export dialog carries the
 *      member's authenticator code and its action verifies it immediately
 *      before calling here, so every export costs one code;
 *   4. the member's REVEAL KEY (`lockRevealBudget`), and their standing
 *      re-read after it: an export racing the member's removal either
 *      commits first — and the removal, waiting on the key, then reads its
 *      rows and flags every exported login (C63 (d), `offboarding.ts`) — or
 *      waits and is refused. The export does NOT spend the hourly reveal
 *      budget: one export would otherwise lock its owner out of single
 *      reveals for an hour. What bounds exports is the code each one costs
 *      (the step-up budget) and the mail each one sends;
 *   5. what the member asked for, as far as their scope reaches — our own
 *      logins only for a tenant-wide scope (C49); nothing reachable is
 *      NOTHING_TO_EXPORT, the same answer for an empty client and one out
 *      of reach.
 * Then, in the one transaction: every listed login's secret and seed read
 * in one statement and decrypted, ONE `credential.exported` per login
 * (target the login — so a login's trail and the offboarding flags read
 * an export as they read a reveal), and the security notice to every
 * holder of the code (C63 (b)).
 *
 * WHAT IS IN IT: every LIVE login the member reaches — archived ones and
 * SEALED ones included (the seal keeps the client out, never the agency's
 * own staff; C60 (d)) — and nothing from the bin. Current secrets only;
 * earlier versions stay in the vault.
 *
 * Nothing here logs, and no error carries a value.
 */

/** "Always": a factor this recent, which the export action has just verified. */
export const EXPORT_STEP_UP_MINUTES = 1;

/** The most logins one file carries; past it the member exports one client at a time. */
export const EXPORT_MAX = 5000;

/** The export's transaction budget: one read, many decrypts and one audit insert per login. */
const EXPORT_TX_TIMEOUT_MS = 15_000;

/** What the member asked to export. */
export type ExportScope =
  | { readonly kind: "all" }
  | { readonly kind: "agency" }
  | { readonly kind: "client"; readonly clientId: string };

export type VaultExportFile = {
  /** The file — plaintext secrets; the caller hands it to the member and keeps nothing. */
  readonly csv: string;
  readonly count: number;
  /** Values that would start a spreadsheet cell with a formula character (`export-csv.ts`). */
  readonly formulaValues: number;
  /** Logins with a field too long for Bitwarden to import — to be copied by hand. */
  readonly tooLong: readonly string[];
};

/** A scope from a caller, held to its three shapes before anything is read. */
function scopeOf(raw: ExportScope): ExportScope {
  if (raw?.kind === "all" || raw?.kind === "agency") return { kind: raw.kind };
  if (raw?.kind === "client") return { kind: "client", clientId: idOf(raw.clientId, "clientId") };
  return fail("INVALID_INPUT", "scope");
}

const exportSelect = {
  id: true,
  type: true,
  name: true,
  username: true,
  url: true,
  notes: true,
  tags: true,
  expiresAt: true,
  rotateEveryDays: true,
  lastRotatedAt: true,
  needsRotation: true,
  visibility: true,
  sealedAt: true,
  archivedAt: true,
  clientId: true,
  client: { select: { name: true } },
  project: { select: { name: true } },
} as const;

/**
 * credential:export ✦ (+ credential:reveal ✦, a factor this minute) — the
 * file, in the exporting member's language (`labels`, translated by the
 * caller).
 */
export async function exportCredentials(
  ctx: VaultCtx,
  scope: ExportScope,
  labels: ExportLabels,
): Promise<VaultExportFile> {
  const asked = scopeOf(scope);
  return boundedVaultWrite((opts) =>
    withTenant(
      ctx.tenantId,
      principalOf(ctx),
      async (tx) => {
        await enterVault(tx, ctx, "credential:view");
        await requireAccess(tx, ctx.tenantId, ctx.actor, "credential:export");
        await requireAccess(tx, ctx.tenantId, ctx.actor, "credential:reveal");
        await requireRecentMfa(ctx.actor, EXPORT_STEP_UP_MINUTES);

        const reach = await resolveScope(tx, ctx.actor);
        // Our own logins are a tenant-wide member's alone (C49): asked for by
        // anyone else, there is nothing to export — the answer an empty client
        // gets. A BELT, refused before the member's key is taken: the reads
        // below skip our own for such a member on their own (the mutation
        // check that removes this line stays green, by design).
        if (asked.kind === "agency" && !reach.all) fail("NOTHING_TO_EXPORT");
        await lockRevealBudget(tx, ctx.tenantId, ctx.actor.memberId);

        // TWO reads in sequence, as `listAllCredentials` does: our own first
        // (Postgres sorts a missing client's NULL name last), then client by
        // client, by name. One past the cap is read to know it was passed.
        const live = { tenantId: ctx.tenantId, deletedAt: null };
        const over = EXPORT_MAX + 1;
        const own =
          reach.all && asked.kind !== "client"
            ? await tx.credentialItem.findMany({
                where: { AND: [{ ...live, clientId: null }, anchorScopeWhere(reach)] },
                orderBy: [{ name: "asc" }, { id: "asc" }],
                take: over,
                select: exportSelect,
              })
            : [];
        const clients =
          asked.kind === "agency" || own.length >= over
            ? []
            : await tx.credentialItem.findMany({
                where: {
                  AND: [
                    { ...live, clientId: asked.kind === "client" ? asked.clientId : { not: null } },
                    anchorScopeWhere(reach),
                  ],
                },
                orderBy: [{ client: { name: "asc" } }, { clientId: "asc" }, { name: "asc" }, { id: "asc" }],
                take: over - own.length,
                select: exportSelect,
              });
        const items = [...own, ...clients];
        if (items.length === 0) fail("NOTHING_TO_EXPORT");
        if (items.length > EXPORT_MAX) fail("EXPORT_TOO_LARGE");

        const secrets = await readSecretsForExport(
          tx,
          ctx.tenantId,
          items.map((i) => i.id),
        );
        const tenant = await tx.tenant.findFirst({ where: { id: ctx.tenantId }, select: { name: true } });
        // One folder per anchor — our own under the workspace's name, each
        // client under its own — told apart when two share a name (two
        // clients called the same, or one called like the workspace), which
        // a password manager would otherwise pour into one folder.
        const folders = new Map<string | null, string>();
        const taken = new Set<string>();
        for (const i of items) {
          if (folders.has(i.clientId)) continue;
          const base = i.clientId === null ? (tenant?.name ?? "") : (i.client?.name ?? "");
          let name = base;
          // Compared as WRITTEN (`folderName`: look-alike slashes, a neutralised
          // lead), so "A/B" and a client literally named "A∕B" are told apart too.
          const key = (n: string) => folderName(n).toLowerCase();
          for (let n = 2; taken.has(key(name)); n++) name = `${base} (${n})`;
          taken.add(key(name));
          folders.set(i.clientId, name);
        }
        const rows: ExportRow[] = items.map((i) => {
          const secret = secrets.get(i.id);
          // Every live login has its secret row (written with it); a missing
          // one is a broken invariant, never a login to write without it.
          if (!secret) throw new Error("vault: a live credential has no secret row");
          return {
            type: i.type,
            name: i.name,
            username: i.username,
            url: i.url,
            notes: i.notes,
            tags: i.tags,
            expiresAt: i.expiresAt,
            rotateEveryDays: i.rotateEveryDays,
            lastRotatedAt: i.lastRotatedAt,
            needsRotation: i.needsRotation,
            shownToClient: i.visibility === "CLIENT_VISIBLE",
            sealed: i.sealedAt !== null,
            archived: i.archivedAt !== null,
            folder: folders.get(i.clientId) ?? "",
            project: i.project?.name ?? null,
            secret: secret.fields,
            totp: secret.totp,
          };
        });
        const file = toBitwardenCsv(rows, labels);

        const exportId = newId();
        await recordMany(
          tx,
          items.map((i) => ({
            action: "credential.exported" as const,
            targetType: "CredentialItem",
            targetId: i.id,
            metadata: {
              exportId,
              scope: asked.kind,
              ...(asked.kind === "client" ? { clientId: asked.clientId } : {}),
              // The authenticator seed left in the file (C63 (e)): a departed
              // exporter keeps the mark until the seed is replaced too.
              // Dated when written — AFTER the read above, since an audit row is
              // stamped at its insert, not at its transaction's start (measured
              // in `export.dbtest.ts`) — so a seed change that committed while
              // the export waited is older than this row, as it is older than
              // the seed in the file.
              ...(secrets.get(i.id)?.totp ? { seed: true } : {}),
            },
          })),
        );
        await mailExportHolders(tx, ctx.tenantId, exportId);
        return { csv: file.csv, count: items.length, formulaValues: file.formulaValues, tooLong: file.tooLong };
      },
      { ...opts, timeoutMs: EXPORT_TX_TIMEOUT_MS },
    ),
  );
}

/**
 * THE SECURITY NOTICE (C63 (b)): every ACTIVE member who holds
 * `credential:export` through a role — owners by default — the exporter
 * included, whatever their email level, straight into the outbox in the
 * export's own transaction, so a mail exists exactly when an export
 * committed. Read as `answerersOf` reads the holders of `credential:unseal`
 * (`sealed-mail.ts`): gate 4, with no factor asked — a person is told
 * whether or not they stepped up lately. NOT scoped: the mail names no
 * client, login or count (ARC-09), so a holder kept to some clients learns
 * only that an export happened. Suppressed addresses are left out (the
 * worker checks again at send); idempotent by the export and the receiver.
 */
async function mailExportHolders(tx: TenantDb, tenantId: string, exportId: string): Promise<void> {
  const holders = await tx.member.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      memberRoles: {
        some: {
          role: {
            rolePermissions: { some: { source: { not: "TENANT_REVOKE" }, permission: { code: "credential:export" } } },
          },
        },
      },
    },
    select: { id: true, user: { select: { email: true, locale: true } } },
    orderBy: { id: "asc" },
  });
  const receivers = holders.flatMap((m) =>
    m.user.email ? [{ id: m.id, email: m.user.email.toLowerCase(), locale: m.user.locale === "sv" ? "sv" : "en" }] : [],
  );
  if (receivers.length === 0) return;
  const suppressed = new Set(
    (
      await tx.emailSuppression.findMany({
        where: { email: { in: receivers.map((r) => r.email) } },
        select: { email: true },
      })
    ).map((s) => s.email),
  );
  const data = receivers
    .filter((r) => !suppressed.has(r.email))
    .map((r) => ({
      tenantId,
      idempotencyKey: `vault_export:${exportId}:MEMBER:${r.id}`,
      receiverType: "MEMBER" as const,
      receiverId: r.id,
      toEmail: r.email,
      kind: VAULT_EXPORTED_MAIL,
      locale: r.locale,
      notificationIds: [],
    }));
  if (data.length > 0) await tx.emailOutbox.createMany({ data, skipDuplicates: true });
}

/** How far back, and how many, the exports page lists. */
export const EXPORT_HISTORY_DAYS = 90;
export const EXPORT_HISTORY_LIMIT = 20;

/** One export as the exports page lists it — who, how many, which, when. */
export type VaultExportRecord = {
  readonly exportId: string;
  /** The exporter's name, or null when the member is gone. */
  readonly by: string | null;
  readonly count: number;
  readonly scope: "all" | "agency" | "client";
  /** The client, for a one-client export — null when it is gone. */
  readonly client: { readonly id: string; readonly name: string } | null;
  readonly at: Date;
};

/** What the exports page may show this member. */
export type VaultExportHistory =
  | {
      readonly kind: "list";
      readonly rows: readonly VaultExportRecord[];
      /** More exports in the window than `EXPORT_HISTORY_LIMIT` — the page says it shows the latest. */
      readonly more: boolean;
    }
  /** A holder of the code kept to some clients: told the list is not theirs to see. */
  | { readonly kind: "scoped" };

/**
 * The workspace's exports of the last `EXPORT_HISTORY_DAYS` days, newest
 * first — where every holder's security notice lands (`/vault/exports`).
 * Behind the vault's door like every vault read, then for a member who
 * holds `credential:export`: anyone else gets `null`, the page's 404. A
 * holder whose scope is NOT the whole tenant gets `scoped` and no rows,
 * since an export of everything says how many logins the agency keeps and
 * a one-client export names the client — but they were mailed too, so the
 * page they land on says why it is empty rather than that it is not there.
 *
 * Read from the audit rows themselves (`credential.exported`, grouped by
 * export), so there is no second record to keep in step. `audit_event` has
 * no index on its action, so this scans the window's rows through
 * `(tenant_id, created_at)` — fine for a page opened from a notice, and
 * the reason it is NOT read on every `/vault`.
 */
export async function listVaultExports(ctx: VaultCtx): Promise<VaultExportHistory | null> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await enterVault(tx, ctx, "credential:view");
    // A ✦ code, answered inside the window the door has just proved — `openVault`'s reasoning.
    const { accessible } = await heldAndAccessibleCodes(tx, ctx.tenantId, ctx.actor, ["credential:export"]);
    if (!accessible.has("credential:export")) return null;
    const reach = await resolveScope(tx, ctx.actor);
    if (!reach.all) return { kind: "scoped" };

    const groups = await tx.$queryRaw<
      { export_id: string | null; actor_id: string | null; at: Date; logins: number; scope: string | null; client_id: string | null }[]
    >`
      SELECT a.metadata->>'exportId' AS export_id,
             a.actor_id,
             min(a.created_at) AS at,
             count(*)::int AS logins,
             min(a.metadata->>'scope') AS scope,
             min(a.metadata->>'clientId') AS client_id
      FROM audit_event a
      WHERE a.tenant_id = ${ctx.tenantId}
        AND a.action = 'credential.exported'
        AND a.actor_type = 'MEMBER'
        AND a.created_at >= now() - make_interval(days => ${EXPORT_HISTORY_DAYS}::int)
      GROUP BY 1, 2
      ORDER BY at DESC
      LIMIT ${EXPORT_HISTORY_LIMIT + 1}`;
    // One past the limit is read to know there were more, and dropped.
    const more = groups.length > EXPORT_HISTORY_LIMIT;
    groups.splice(EXPORT_HISTORY_LIMIT);
    const memberIds = [...new Set(groups.flatMap((g) => (g.actor_id ? [g.actor_id] : [])))];
    // In sequence (AGENTS.md's `Promise.all` trap).
    const members =
      memberIds.length === 0
        ? []
        : await tx.member.findMany({
            where: { tenantId: ctx.tenantId, id: { in: memberIds } },
            select: { id: true, user: { select: { name: true } } },
          });
    const clientIds = [...new Set(groups.flatMap((g) => (g.client_id ? [g.client_id] : [])))];
    const clients =
      clientIds.length === 0
        ? []
        : await tx.client.findMany({ where: { tenantId: ctx.tenantId, id: { in: clientIds } }, select: { id: true, name: true } });
    const nameOf = new Map(members.map((m) => [m.id, m.user.name]));
    const clientOf = new Map(clients.map((c) => [c.id, c]));
    const rows = groups.flatMap((g): VaultExportRecord[] => {
      if (g.export_id === null) return [];
      const scope = g.scope === "agency" || g.scope === "client" ? g.scope : "all";
      const client = g.client_id ? (clientOf.get(g.client_id) ?? null) : null;
      return [
        {
          exportId: g.export_id,
          by: g.actor_id ? (nameOf.get(g.actor_id) ?? null) : null,
          count: g.logins,
          scope,
          client: client === null ? null : { id: client.id, name: client.name },
          at: g.at,
        },
      ];
    });
    return { kind: "list", rows, more };
  });
}
