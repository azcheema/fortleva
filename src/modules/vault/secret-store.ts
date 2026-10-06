import { randomUUID } from "node:crypto";

import { decryptFieldV2, encryptFieldV2 } from "@/crypto/field-encryption";
import type { TenantDb } from "@/db";

import type { TotpParams } from "./totp";

/**
 * THE ONLY FILE THAT TOUCHES VAULT CIPHERTEXT (SECURITY.md §6.1–§6.3;
 * DATA_MODEL.md §6.17). `src/db/client.ts` omits the three ciphertext
 * columns from every read in the product; the reads below are the only
 * opt-ins for them (`omit: { …: false }`, never alongside a `select`,
 * which Prisma refuses) — `readSecret`, `readTotp`, and since slice 95 the
 * export's bulk read, whose only caller is pinned — and
 * `vault-boundary.test.ts` fails the unit suite if a ciphertext column is
 * named anywhere else in `src/`.
 *
 * Every ciphertext is v2 under the tenant's DEK with AAD
 * `tenantId:<table>:<rowId>:<field>` (the normative convention):
 *   credential_secret:<credentialId>:secret       — the type's fields
 *   credential_secret:<credentialId>:totp_secret  — the TOTP seed
 *   credential_version:<versionId>:secret         — a previous secret
 * so a ciphertext copied to another row, another tenant or the other
 * column fails authentication instead of decrypting. Plaintext exists in
 * this process only between a decrypt and the caller's use of ONE field —
 * the export aside, which decrypts every login it writes into the file;
 * nothing here logs, and no error message carries a value.
 */

/** The decrypted secret: the type's fields, keyed as `SECRET_FIELDS` says. */
export type SecretPayload = { readonly v: 1; readonly fields: Readonly<Record<string, string>> };
type TotpPayload = { readonly v: 1 } & TotpParams;

/** How many previous secrets a credential keeps (DATA_MODEL.md §6.17: "last N"). */
export const VERSIONS_KEPT = 10;

const SECRET_MODEL = "credential_secret";
const VERSION_MODEL = "credential_version";

const encryptSecret = (tx: TenantDb, tenantId: string, credentialId: string, fields: Record<string, string>) =>
  encryptFieldV2(
    tx,
    { tenantId, model: SECRET_MODEL, rowId: credentialId, field: "secret" },
    JSON.stringify({ v: 1, fields } satisfies SecretPayload),
  );

const encryptTotp = (tx: TenantDb, tenantId: string, credentialId: string, params: TotpParams) =>
  encryptFieldV2(
    tx,
    { tenantId, model: SECRET_MODEL, rowId: credentialId, field: "totp_secret" },
    JSON.stringify({ v: 1, ...params } satisfies TotpPayload),
  );

/**
 * The secret row of a NEW credential: its fields and, when given, its TOTP
 * seed, each encrypted under this credential's id (which is why the id is
 * minted before the item row is written).
 */
export async function insertSecretRow(
  tx: TenantDb,
  args: {
    readonly tenantId: string;
    readonly credentialId: string;
    readonly fields: Record<string, string>;
    readonly totp: TotpParams | null;
    readonly memberId: string;
  },
): Promise<void> {
  const secretCiphertext = await encryptSecret(tx, args.tenantId, args.credentialId, args.fields);
  const totpSecretCiphertext =
    args.totp === null ? null : await encryptTotp(tx, args.tenantId, args.credentialId, args.totp);
  await tx.credentialSecret.create({
    data: {
      credentialId: args.credentialId,
      tenantId: args.tenantId,
      secretCiphertext,
      totpSecretCiphertext,
      updatedByMemberId: args.memberId,
    },
    select: { credentialId: true },
  });
}

/**
 * Replace a credential's secret and/or seed. `fields` replaces the field
 * map and sets `version` (the caller has already kept the old one with
 * `keepPreviousVersion`); `totp` replaces the seed, or removes it when
 * `null`; an absent argument leaves that column alone.
 */
export async function updateSecretRow(
  tx: TenantDb,
  args: {
    readonly tenantId: string;
    readonly credentialId: string;
    readonly replace?: { readonly fields: Record<string, string>; readonly version: number };
    readonly totp?: TotpParams | null;
    readonly memberId: string;
  },
): Promise<void> {
  const secretCiphertext =
    args.replace === undefined ? undefined : await encryptSecret(tx, args.tenantId, args.credentialId, args.replace.fields);
  const totpSecretCiphertext =
    args.totp === undefined
      ? undefined
      : args.totp === null
        ? null
        : await encryptTotp(tx, args.tenantId, args.credentialId, args.totp);
  await tx.credentialSecret.update({
    where: { credentialId: args.credentialId, tenantId: args.tenantId },
    data: {
      ...(secretCiphertext === undefined || args.replace === undefined
        ? {}
        : { secretCiphertext, version: args.replace.version }),
      ...(totpSecretCiphertext === undefined ? {} : { totpSecretCiphertext }),
      updatedByMemberId: args.memberId,
    },
    select: { credentialId: true },
  });
}

/**
 * `JSON.parse` on DECRYPTED text, without its error: V8's SyntaxError
 * quotes the input it could not parse, so a plaintext that was ever not
 * JSON — a future importer or brokered writer storing a bare value under
 * a valid AAD — would surface the secret in an error and a log (security
 * review, 2026-10-01). The cause is dropped on purpose.
 */
function parseDecrypted(json: string, what: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new Error(`vault: stored ${what} is not readable`);
  }
}

const parseSecret = (json: string): SecretPayload => {
  const parsed = parseDecrypted(json, "secret") as Partial<SecretPayload> | null;
  if (parsed?.v !== 1 || typeof parsed.fields !== "object" || parsed.fields === null || Array.isArray(parsed.fields)) {
    throw new Error("vault: stored secret has an unknown shape");
  }
  // Every value a string (slice 95's security review): a number written by
  // a path that skipped `normalizeSecretPatch` would otherwise reach a
  // caller — and a Node error that prints its argument — as a value. The
  // error names no value.
  if (Object.values(parsed.fields).some((v) => typeof v !== "string")) {
    throw new Error("vault: stored secret has an unknown shape");
  }
  return { v: 1, fields: parsed.fields };
};

/** The live secret of one credential, decrypted, or null when it has no row. */
export async function readSecret(
  tx: TenantDb,
  tenantId: string,
  credentialId: string,
): Promise<{ readonly payload: SecretPayload; readonly version: number } | null> {
  const row = await tx.credentialSecret.findFirst({
    where: { tenantId, credentialId },
    omit: { secretCiphertext: false },
  });
  if (!row) return null;
  const json = await decryptFieldV2(
    tx,
    { tenantId, model: SECRET_MODEL, rowId: credentialId, field: "secret" },
    row.secretCiphertext,
  );
  return { payload: parseSecret(json), version: row.version };
}

/**
 * The live secret's VERSION only — no ciphertext read, nothing decrypted.
 * A share link pins it when it is made (`share-links.ts`) and the share
 * page compares it before showing anything (`share-open.ts`): a link
 * shares the secret as it was, and a changed secret ends it.
 */
export async function readSecretVersion(tx: TenantDb, tenantId: string, credentialId: string): Promise<number | null> {
  const row = await tx.credentialSecret.findFirst({
    where: { tenantId, credentialId },
    select: { version: true },
  });
  return row?.version ?? null;
}

/** The TOTP parameters of one credential, decrypted, or null when it has none. */
export async function readTotp(tx: TenantDb, tenantId: string, credentialId: string): Promise<TotpParams | null> {
  const row = await tx.credentialSecret.findFirst({
    where: { tenantId, credentialId },
    omit: { totpSecretCiphertext: false },
  });
  if (!row?.totpSecretCiphertext) return null;
  const json = await decryptFieldV2(
    tx,
    { tenantId, model: SECRET_MODEL, rowId: credentialId, field: "totp_secret" },
    row.totpSecretCiphertext,
  );
  return parseTotp(json);
}

function parseTotp(json: string): TotpParams {
  const parsed = parseDecrypted(json, "TOTP seed") as Partial<TotpPayload> | null;
  if (parsed?.v !== 1 || typeof parsed.secret !== "string") {
    throw new Error("vault: stored TOTP seed has an unknown shape");
  }
  return {
    secret: parsed.secret,
    algorithm: parsed.algorithm ?? "SHA1",
    digits: parsed.digits ?? 6,
    period: parsed.period ?? 30,
  };
}

/** One login's whole secret, as the export writes it. */
export type ExportedSecret = { readonly fields: Readonly<Record<string, string>>; readonly totp: TotpParams | null };

/**
 * THE EXPORT'S READ (slice 95, `export.ts`): every listed credential's
 * secret AND seed, in ONE statement — a vault of hundreds of logins must
 * not cost a round trip each inside the export's transaction — each
 * decrypted under its own AAD exactly as `readSecret` / `readTotp` do (the
 * tenant's DEK is cached, so the decrypts are in-process). Its only caller
 * is the export, which has passed every gate and writes one audit row per
 * login in the same transaction. A listed id with no secret row is
 * absent from the map, and the caller refuses the export rather than
 * writing a login without its secret.
 */
export async function readSecretsForExport(
  tx: TenantDb,
  tenantId: string,
  credentialIds: readonly string[],
): Promise<Map<string, ExportedSecret>> {
  const out = new Map<string, ExportedSecret>();
  if (credentialIds.length === 0) return out;
  const rows = await tx.credentialSecret.findMany({
    where: { tenantId, credentialId: { in: [...credentialIds] } },
    omit: { secretCiphertext: false, totpSecretCiphertext: false },
  });
  for (const row of rows) {
    const json = await decryptFieldV2(
      tx,
      { tenantId, model: SECRET_MODEL, rowId: row.credentialId, field: "secret" },
      row.secretCiphertext,
    );
    const totp = row.totpSecretCiphertext
      ? parseTotp(
          await decryptFieldV2(
            tx,
            { tenantId, model: SECRET_MODEL, rowId: row.credentialId, field: "totp_secret" },
            row.totpSecretCiphertext,
          ),
        )
      : null;
    out.set(row.credentialId, { fields: parseSecret(json).fields, totp });
  }
  return out;
}

/**
 * Keep the secret being replaced as a version row, re-encrypted under the
 * VERSION row's own AAD, and drop the versions beyond the newest
 * `VERSIONS_KEPT`. The payload also names its CREDENTIAL: the AAD binds a
 * version's ciphertext to the version row, not to `credential_id`, so a
 * row re-parented to another credential by a database writer would still
 * decrypt — the history read path (a later slice) must refuse a payload
 * whose `credentialId` is not the row's (security review, 2026-10-01). Runs in the caller's transaction, after the credential
 * row was locked, so two replacements cannot both claim one version
 * number (and the unique on (tenant, credential, version) would refuse it
 * if they did).
 */
export async function keepPreviousVersion(
  tx: TenantDb,
  args: {
    readonly tenantId: string;
    readonly credentialId: string;
    readonly previous: SecretPayload;
    readonly previousVersion: number;
    readonly changedByMemberId: string;
  },
): Promise<void> {
  const id = randomUUID();
  const secretCiphertext = await encryptFieldV2(
    tx,
    { tenantId: args.tenantId, model: VERSION_MODEL, rowId: id, field: "secret" },
    JSON.stringify({ ...args.previous, credentialId: args.credentialId }),
  );
  await tx.credentialVersion.create({
    data: {
      id,
      tenantId: args.tenantId,
      credentialId: args.credentialId,
      version: args.previousVersion,
      secretCiphertext,
      changedByMemberId: args.changedByMemberId,
    },
    select: { id: true },
  });
  const stale = await tx.credentialVersion.findMany({
    where: { tenantId: args.tenantId, credentialId: args.credentialId },
    orderBy: { version: "desc" },
    skip: VERSIONS_KEPT,
    select: { id: true },
  });
  if (stale.length > 0) {
    await tx.credentialVersion.deleteMany({
      where: { tenantId: args.tenantId, id: { in: stale.map((s) => s.id) } },
    });
  }
}
