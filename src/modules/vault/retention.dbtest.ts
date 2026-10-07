import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTenantDekCache } from "@/crypto/tenant-key";
import { withTenant, type TenantDb } from "@/db";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { setModuleEnabled } from "@/preferences/service";

import {
  createCredential,
  deleteCredential,
  flagLoginsKnownBy,
  purgeVaultRetention,
  readPortalSubmissions,
  replaceCredentialSecret,
  revealCredentialField,
  submitPortalCredential,
  updateCredential,
} from "./index";

/**
 * THE VAULT'S RETENTION against the real database and the real app_runtime
 * role (Phase 3V slice 99; DATA_MODEL.md §5 R2; founder decision C67 (a),
 * (f)). A login 30 days in the bin has its secret erased; its row is
 * DELETED (versions and old links with it) unless a client's contact sent
 * it — then it stays as the client's record of it — or one of its share
 * links' records is still within its 12 months — then it stays, under its
 * own name, until they are not. The database holds who may delete a login,
 * who may make and change a tombstone, and when a link's record may go;
 * two runs at once audit a login once; a held row is skipped, not waited
 * on; a run spans batches; the vault module switched off does not pause
 * it; a member's removal never trips over a tombstone.
 *
 * Calls `purgeVaultRetention(tenantId)` for THIS tenant only — never the
 * job (`runVaultRetention`), which would erase every tenant's bin on the
 * shared dev database (the design review's low).
 *
 * A share link's record past its 12 months cannot be made by any writer —
 * the link's guard stamps a link at its birth — so that half is planted, in
 * CI only, through the superuser OWNER connection with
 * `session_replication_role = replica` for that one statement
 * (`sealed-time.dbtest.ts`'s precedent; nothing in the product changes).
 */

const directUrl = process.env["DIRECT_URL"];
const inCi = process.env["CI"] === "true";
const allowed = inCi || process.env["DBTEST_ALLOW_REPLICA"] === "1";

let owner: pg.Client | null = null;
let superuser = false;
if (allowed && directUrl) {
  owner = new pg.Client({ connectionString: directUrl });
  owner.on("error", () => {});
  try {
    await owner.connect();
    const r = await owner.query<{ rolsuper: boolean }>("SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
    superuser = r.rows[0]?.rolsuper === true;
  } catch (e) {
    if (inCi) throw e;
  }
  if (!superuser) {
    await owner.end().catch(() => {});
    owner = null;
  }
}
if (inCi && !superuser) {
  throw new Error("retention.dbtest: CI's owner connection must be a superuser — the planted half must not skip in CI");
}

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let acme: string;
let carol: string; // Acme, PRIMARY — sends logins

const RUN = randomUUID().slice(0, 8);
const DAY_MS = 86_400_000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY_MS);

const ownerCtx = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) });
const managerCtx = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.manager.memberId) });
const principal = (contactId: string): PortalPrincipal => ({ contactId, tenantId: f.tenantId, clientId: acme, gates });

const asMember = <T>(fn: (tx: TenantDb) => Promise<T>) =>
  withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, fn);
const asSystem = <T>(fn: (tx: TenantDb) => Promise<T>) => withTenant(f.tenantId, { type: "system" }, fn);
const asContact = <T>(fn: (tx: TenantDb) => Promise<T>) =>
  withTenant(f.tenantId, { type: "contact", id: carol, clientId: acme }, fn);

/** Did the statement fail with these words (a guard's, or a constraint's name)? */
const refusedWith = async (p: Promise<unknown>, words: string): Promise<boolean> => {
  try {
    await p;
    return false;
  } catch (e) {
    return String(e instanceof Error ? e.message : e).includes(words);
  }
};

/** A login nobody sent, with a secret and one previous version — and, unless told not to, an open share link. */
const madeLogin = async (label: string, { link = true }: { link?: boolean } = {}): Promise<string> => {
  const { id } = await createCredential(ownerCtx(), {
    clientId: acme,
    type: "LOGIN",
    name: `${label} ${RUN}`,
    username: "admin",
    url: "https://panel.example.test",
    tags: ["infra"],
    secret: { password: `first-${RUN}` },
  });
  await replaceCredentialSecret(ownerCtx(), id, { secret: { password: `second-${RUN}` } });
  if (link) await linkTo(id);
  return id;
};

/** A share link to this login, made as a member makes one (the guard's own rule). */
const linkTo = (credentialId: string) =>
  asMember((tx) =>
    tx.credentialShareLink.create({
      data: {
        tenantId: f.tenantId,
        credentialId,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        field: "password",
        recipientEmail: `vret-to-${RUN}@test.invalid`,
        secretVersion: 1,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        createdByMemberId: f.seats.owner.memberId,
      },
      select: { id: true },
    }),
  );

/** A login Carol SENT through the portal, renamed and tagged by the team, with a previous version and a link. */
const sentLogin = async (label: string): Promise<{ id: string; name: string }> => {
  const name = `${label} ${randomUUID().slice(0, 6)}`;
  await submitPortalCredential(principal(carol), {
    type: "LOGIN",
    name,
    projectId: null,
    username: "client-admin",
    url: "panel.example.test/login",
    notes: "sent by the client",
    secret: { password: `sent-${RUN}` },
  });
  const row = await f.platform.credentialItem.findFirstOrThrow({
    where: { tenantId: f.tenantId, submittedByContactId: carol, submittedName: name },
    select: { id: true },
  });
  await updateCredential(ownerCtx(), row.id, { name: `Team's name for ${label}`, tags: ["infra"], notes: "team note" });
  await replaceCredentialSecret(ownerCtx(), row.id, { secret: { password: `replaced-${RUN}` } });
  await linkTo(row.id);
  return { id: row.id, name };
};

/** Bin it as a member does, then move its bin date back. */
const binned = async (id: string, days: number) => {
  await deleteCredential(ownerCtx(), id);
  await f.platform.credentialItem.update({ where: { id }, data: { deletedAt: daysAgo(days) } });
};

const counts = async (id: string) => ({
  item: await f.platform.credentialItem.count({ where: { id } }),
  secret: await f.platform.credentialSecret.count({ where: { credentialId: id } }),
  versions: await f.platform.credentialVersion.count({ where: { credentialId: id } }),
  links: await f.platform.credentialShareLink.count({ where: { credentialId: id } }),
});

const purgedRows = (id: string) =>
  f.platform.auditEvent.findMany({
    where: { tenantId: f.tenantId, action: "credential.purged", targetId: id },
    select: { actorType: true, actorId: true, metadata: true },
  });

const EMPTIED = {
  username: null,
  url: null,
  notes: null,
  tags: [],
  secretFieldKeys: [],
  hasTotp: false,
  needsRotation: false,
  projectId: null,
  visibility: "INTERNAL",
  sealedAt: null,
  updatedByMemberId: null,
} as const;

/** The tombstone shape, written as the job writes it (or one term off it). */
const tombstoneSql = (
  tx: TenantDb,
  id: string,
  variant: "exact" | "created_at" | "client" | "username" | "stale_stamp" | "rename" = "exact",
) => {
  switch (variant) {
    case "client":
      return tx.$executeRaw`UPDATE credential_item SET purged_at = statement_timestamp(), client_id = NULL,
        name = CASE WHEN submitted_by_contact_id IS NULL THEN name ELSE submitted_name END,
        username = NULL, url = NULL, notes = NULL, tags = '{}', secret_field_keys = '{}', has_totp = false,
        expires_at = NULL, rotate_every_days = NULL, last_rotated_at = NULL, needs_rotation = false,
        compromised_at = NULL, project_id = NULL, archived_at = NULL, updated_by_member_id = NULL WHERE id = ${id}`;
    case "created_at":
      return tx.$executeRaw`UPDATE credential_item SET purged_at = statement_timestamp(),
        name = CASE WHEN submitted_by_contact_id IS NULL THEN name ELSE submitted_name END,
        username = NULL, url = NULL, notes = NULL, tags = '{}', secret_field_keys = '{}', has_totp = false,
        expires_at = NULL, rotate_every_days = NULL, last_rotated_at = NULL, needs_rotation = false,
        compromised_at = NULL, project_id = NULL, archived_at = NULL, updated_by_member_id = NULL,
        created_at = created_at - interval '1 day' WHERE id = ${id}`;
    case "username":
      return tx.$executeRaw`UPDATE credential_item SET purged_at = statement_timestamp(),
        name = CASE WHEN submitted_by_contact_id IS NULL THEN name ELSE submitted_name END,
        url = NULL, notes = NULL, tags = '{}', secret_field_keys = '{}', has_totp = false,
        expires_at = NULL, rotate_every_days = NULL, last_rotated_at = NULL, needs_rotation = false,
        compromised_at = NULL, project_id = NULL, archived_at = NULL, updated_by_member_id = NULL WHERE id = ${id}`;
    case "stale_stamp":
      return tx.$executeRaw`UPDATE credential_item SET purged_at = statement_timestamp() - interval '10 minutes',
        name = CASE WHEN submitted_by_contact_id IS NULL THEN name ELSE submitted_name END,
        username = NULL, url = NULL, notes = NULL, tags = '{}', secret_field_keys = '{}',
        has_totp = false, expires_at = NULL, rotate_every_days = NULL, last_rotated_at = NULL,
        needs_rotation = false, compromised_at = NULL, project_id = NULL, archived_at = NULL,
        updated_by_member_id = NULL WHERE id = ${id}`;
    case "rename":
      return tx.$executeRaw`UPDATE credential_item SET purged_at = statement_timestamp(), name = 'Something else',
        username = NULL, url = NULL, notes = NULL, tags = '{}', secret_field_keys = '{}', has_totp = false,
        expires_at = NULL, rotate_every_days = NULL, last_rotated_at = NULL, needs_rotation = false,
        compromised_at = NULL, project_id = NULL, archived_at = NULL, updated_by_member_id = NULL WHERE id = ${id}`;
    default:
      return tx.$executeRaw`UPDATE credential_item SET purged_at = statement_timestamp(),
        name = CASE WHEN submitted_by_contact_id IS NULL THEN name ELSE submitted_name END,
        username = NULL, url = NULL, notes = NULL, tags = '{}', secret_field_keys = '{}', has_totp = false,
        expires_at = NULL, rotate_every_days = NULL, last_rotated_at = NULL, needs_rotation = false,
        compromised_at = NULL, project_id = NULL, archived_at = NULL, updated_by_member_id = NULL WHERE id = ${id}`;
  }
};

/** Plant a share link dated `monthsAgo` back (CI only — the owner connection, triggers off for this one statement). */
const plantOldLink = async (credentialId: string, monthsAgo: number): Promise<string> => {
  const id = randomUUID();
  await owner!.query("BEGIN");
  try {
    await owner!.query("SET LOCAL session_replication_role = replica");
    await owner!.query(
      `INSERT INTO credential_share_link
         (id, tenant_id, credential_id, token_hash, field, include_username, recipient_email, secret_version,
          expires_at, codes_sent, code_attempts, created_by_member_id, created_at)
       VALUES ($1, $2, $3, $4, 'password', true, $5, 1,
          now() - make_interval(months => $6::int) + interval '1 day', 0, 0, $7,
          now() - make_interval(months => $6::int))`,
      [id, f.tenantId, credentialId, createHash("sha256").update(id).digest("hex"), `vret-old-${RUN}@test.invalid`, monthsAgo, f.seats.owner.memberId],
    );
    await owner!.query("COMMIT");
  } catch (e) {
    await owner!.query("ROLLBACK");
    throw e;
  }
  return id;
};

beforeAll(async () => {
  f = await setupTenant("vret");
  acme = randomUUID();
  carol = randomUUID();
  await f.platform.client.create({ data: { id: acme, tenantId: f.tenantId, name: "Acme" } });
  await f.platform.contact.create({
    data: {
      id: carol,
      tenantId: f.tenantId,
      clientId: acme,
      name: "Carol",
      email: `vret-carol-${RUN}@test.invalid`,
      portalProfile: "CONTACT_PRIMARY",
      portalStatus: "ACTIVE",
      invitedAt: new Date("2026-09-01T09:00:00Z"),
      emailVerified: true,
    },
  });
  gates = await resolvePortalModuleGates(f.tenantId);
}, 180_000);

afterAll(async () => {
  await owner?.end().catch(() => {});
  if (f) {
    await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
    // Logins, tombstones included, by the platform connection (the delete
    // guard leaves an unset principal to the harness); their secrets,
    // versions and links go with them.
    await f.platform.credentialItem.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  }
  resetTenantDekCache();
  await f?.cleanup();
}, 180_000);

describe("the bin — 30 days, then the secret is erased for good", () => {
  it("a login nobody sent, with no share link, goes with its secret and versions; one binned 29 days and a live one stay", async () => {
    const due = await madeLogin("Due", { link: false });
    const young = await madeLogin("Young", { link: false });
    const live = await madeLogin("Live", { link: false });
    await binned(due, 31);
    await binned(young, 29);
    expect(await counts(due)).toEqual({ item: 1, secret: 1, versions: 1, links: 0 });

    expect(await purgeVaultRetention(f.tenantId)).toEqual({ deleted: 1, kept: 0, released: 0, links: 0 });

    expect(await counts(due)).toEqual({ item: 0, secret: 0, versions: 0, links: 0 });
    expect(await counts(young)).toEqual({ item: 1, secret: 1, versions: 1, links: 0 });
    expect(await counts(live)).toEqual({ item: 1, secret: 1, versions: 1, links: 0 });
    expect(await purgedRows(due)).toEqual([{ actorType: "SYSTEM", actorId: null, metadata: { clientId: acme, projectId: null } }]);
    expect(await purgedRows(young)).toEqual([]);
  });

  it("a login nobody sent whose share link is still within its 12 months is kept bare, under its own name, its link kept (C67 (f))", async () => {
    const linked = await madeLogin("Linked");
    const before = await f.platform.credentialItem.findUniqueOrThrow({ where: { id: linked } });
    await binned(linked, 31);

    expect(await purgeVaultRetention(f.tenantId)).toEqual({ deleted: 0, kept: 1, released: 0, links: 0 });

    const row = await f.platform.credentialItem.findUniqueOrThrow({ where: { id: linked } });
    expect(row.purgedAt).not.toBeNull();
    expect(row).toMatchObject({
      ...EMPTIED,
      name: before.name,
      clientId: acme,
      type: before.type,
      createdAt: before.createdAt,
      createdByMemberId: before.createdByMemberId,
      submittedByContactId: null,
    });
    expect(await counts(linked)).toEqual({ item: 1, secret: 0, versions: 0, links: 1 });
    expect(await purgedRows(linked)).toEqual([
      { actorType: "SYSTEM", actorId: null, metadata: { clientId: acme, projectId: null, kept: "links" } },
    ]);
    // While its link is young, a run leaves it be.
    expect(await purgeVaultRetention(f.tenantId)).toEqual({ deleted: 0, kept: 0, released: 0, links: 0 });
    expect(await counts(linked)).toEqual({ item: 1, secret: 0, versions: 0, links: 1 });
  });

  it("a login a client sent stays as THEIR record — their name for it and the date — and nothing secret", async () => {
    const sent = await sentLogin("Hosting");
    const before = await f.platform.credentialItem.findUniqueOrThrow({ where: { id: sent.id } });
    expect(before.name).not.toBe(sent.name); // the team renamed it
    await binned(sent.id, 31);
    const binnedAt = (await f.platform.credentialItem.findUniqueOrThrow({ where: { id: sent.id } })).deletedAt;

    expect(await purgeVaultRetention(f.tenantId)).toEqual({ deleted: 0, kept: 1, released: 0, links: 0 });

    const row = await f.platform.credentialItem.findUniqueOrThrow({ where: { id: sent.id } });
    expect(row.purgedAt).not.toBeNull();
    expect(row).toMatchObject({
      ...EMPTIED,
      clientId: acme,
      submittedByContactId: carol,
      submittedName: sent.name,
      name: sent.name, // the team's rename is gone with the rest
      type: before.type,
      createdAt: before.createdAt,
      deletedAt: binnedAt,
    });
    // Its link's record is kept its months (C67 (f)); the secret is gone.
    expect(await counts(sent.id)).toEqual({ item: 1, secret: 0, versions: 0, links: 1 });
    expect(await purgedRows(sent.id)).toEqual([
      { actorType: "SYSTEM", actorId: null, metadata: { clientId: acme, projectId: null, kept: "sent" } },
    ]);
    // The client's own list still says what they sent, by their name for it, and when.
    const list = await readPortalSubmissions(principal(carol));
    expect(list.sent).toContainEqual({ name: sent.name, sentAt: before.createdAt });
    // Done once: a second run finds nothing.
    expect(await purgeVaultRetention(f.tenantId)).toEqual({ deleted: 0, kept: 0, released: 0, links: 0 });
    expect(await purgedRows(sent.id)).toHaveLength(1);
  });

  it("a tombstone nobody sent with no young link left is released", async () => {
    // Made bare by the system (as the job would, had its link aged), with no link at all.
    const bare = await madeLogin("Bare", { link: false });
    await binned(bare, 31);
    await asSystem((tx) => tombstoneSql(tx, bare));
    const run = await purgeVaultRetention(f.tenantId);
    expect(run.released).toBeGreaterThanOrEqual(1);
    expect((await counts(bare)).item).toBe(0);
  });
});

describe("the database holds the bin's rules", () => {
  it("only the SYSTEM principal makes a tombstone — of a login binned 30 days, stamped now, its record kept, its shape exact", async () => {
    const tenDays = await sentLogin("Ten days");
    await binned(tenDays.id, 10);
    expect(await refusedWith(asSystem((tx) => tombstoneSql(tx, tenDays.id)), "after 30 days in the bin")).toBe(true);

    const due = await sentLogin("Due");
    await binned(due.id, 31);
    expect(await refusedWith(asMember((tx) => tombstoneSql(tx, due.id)), "only the retention job")).toBe(true);
    expect(await asContact((tx) => tombstoneSql(tx, due.id))).toBe(0); // a contact's UPDATE matches no row
    expect(await refusedWith(asSystem((tx) => tombstoneSql(tx, due.id, "created_at")), "keeps the record")).toBe(true);
    expect(await refusedWith(asSystem((tx) => tombstoneSql(tx, due.id, "stale_stamp")), "stamped when it happens")).toBe(true);
    expect(await refusedWith(asSystem((tx) => tombstoneSql(tx, due.id, "username")), "credential_item_purged_shape")).toBe(true);
    // A SENT tombstone is named as it was sent.
    expect(await refusedWith(asSystem((tx) => tombstoneSql(tx, due.id, "rename")), "credential_item_purged_shape")).toBe(true);
    expect((await f.platform.credentialItem.findUniqueOrThrow({ where: { id: due.id } })).purgedAt).toBeNull();

    // One nobody sent keeps its own name (the links' records name it), and its client.
    const nobody = await madeLogin("Nobody sent");
    await binned(nobody, 31);
    expect(await refusedWith(asSystem((tx) => tombstoneSql(tx, nobody, "rename")), "keeps the record")).toBe(true);
    expect(await refusedWith(asSystem((tx) => tombstoneSql(tx, nobody, "client")), "keeps the record")).toBe(true);
    expect(await asSystem((tx) => tombstoneSql(tx, nobody))).toBe(1);

    // No INSERT writes a tombstone — not even the platform connection the guards otherwise leave alone.
    expect(
      await refusedWith(
        f.platform.credentialItem.create({
          data: { tenantId: f.tenantId, type: "LOGIN", name: `Born erased ${RUN}`, deletedAt: daysAgo(40), purgedAt: new Date() },
        }),
        "born live",
      ),
    ).toBe(true);
  });

  it("a tombstone never changes again — not by the system, not by a member", async () => {
    const sent = await sentLogin("Frozen");
    await binned(sent.id, 31);
    await purgeVaultRetention(f.tenantId);
    expect((await f.platform.credentialItem.findUniqueOrThrow({ where: { id: sent.id } })).purgedAt).not.toBeNull();
    expect(await refusedWith(asSystem((tx) => tx.$executeRaw`UPDATE credential_item SET notes = 'back' WHERE id = ${sent.id}`), "never changes")).toBe(true);
    expect(await refusedWith(asMember((tx) => tx.$executeRaw`UPDATE credential_item SET needs_rotation = true WHERE id = ${sent.id}`), "never changes")).toBe(true);
    expect(await refusedWith(asSystem((tx) => tx.$executeRaw`UPDATE credential_item SET purged_at = NULL WHERE id = ${sent.id}`), "never changes")).toBe(true);
  });

  it("only the SYSTEM principal deletes a login — one nobody sent, binned 30 days, with no share link still in its months", async () => {
    const live = await madeLogin("Live delete", { link: false });
    const deleteOf = (id: string) => (tx: TenantDb) => tx.$executeRaw`DELETE FROM credential_item WHERE id = ${id}`;
    expect(await refusedWith(asMember(deleteOf(live)), "CREDENTIAL_DELETE_GUARD")).toBe(true);
    expect(await refusedWith(asSystem(deleteOf(live)), "CREDENTIAL_DELETE_GUARD")).toBe(true);
    expect(await asContact(deleteOf(live))).toBe(0); // a contact's DELETE matches no row

    const tenDays = await madeLogin("Ten days delete", { link: false });
    await binned(tenDays, 10);
    expect(await refusedWith(asSystem(deleteOf(tenDays)), "CREDENTIAL_DELETE_GUARD")).toBe(true);

    // Binned long enough, but a link of it is still within its months: its
    // DELETE would take that record with it.
    const linked = await madeLogin("Linked delete");
    await binned(linked, 31);
    expect(await refusedWith(asSystem(deleteOf(linked)), "CREDENTIAL_DELETE_GUARD")).toBe(true);

    const sent = await sentLogin("Sent delete");
    await binned(sent.id, 31);
    expect(await refusedWith(asSystem(deleteOf(sent.id)), "CREDENTIAL_DELETE_GUARD")).toBe(true);
    await purgeVaultRetention(f.tenantId); // now tombstones, both
    expect(await refusedWith(asSystem(deleteOf(sent.id)), "CREDENTIAL_DELETE_GUARD")).toBe(true);
    expect(await refusedWith(asSystem(deleteOf(linked)), "CREDENTIAL_DELETE_GUARD")).toBe(true);

    for (const id of [live, tenDays, linked, sent.id]) expect((await counts(id)).item).toBe(1);
  });

  it("a share link's record is deleted only with its login, or by the SYSTEM once 12 months past its expiry", async () => {
    const live = await madeLogin("Link guard");
    const link = await f.platform.credentialShareLink.findFirstOrThrow({ where: { credentialId: live }, select: { id: true } });
    const deleteLink = (tx: TenantDb) => tx.$executeRaw`DELETE FROM credential_share_link WHERE id = ${link.id}`;
    expect(await refusedWith(asMember(deleteLink), "CRED_SHARE_LINK_DELETE_GUARD")).toBe(true);
    expect(await refusedWith(asSystem(deleteLink), "kept 12 months")).toBe(true);
    expect(await asContact(deleteLink)).toBe(0); // class A: a contact sees no link
    // …nor once its login is a tombstone (C67 (f)).
    await binned(live, 31);
    await purgeVaultRetention(f.tenantId);
    expect((await f.platform.credentialItem.findUniqueOrThrow({ where: { id: live } })).purgedAt).not.toBeNull();
    expect(await refusedWith(asSystem(deleteLink), "kept 12 months")).toBe(true);
    expect((await counts(live)).links).toBe(1);
  });

  it.skipIf(owner === null)("12 months on, a link's record is swept, a bare login released with its last one, and a login whose links are all old deleted outright (planted — CI)", async () => {
    // A live login: one link 14 months past, one 11.
    const live = await madeLogin("Old links", { link: false });
    const old = await plantOldLink(live, 14);
    const recent = await plantOldLink(live, 11);
    // A tombstone nobody sent whose only link is past its months.
    const bare = await madeLogin("Bare old", { link: false });
    await plantOldLink(bare, 14);
    await binned(bare, 31);
    await asSystem((tx) => tombstoneSql(tx, bare));
    // A binned login whose only link is past its months: deleted outright, the link with it.
    const gone = await madeLogin("Gone old", { link: false });
    await plantOldLink(gone, 14);
    await binned(gone, 31);

    const run = await purgeVaultRetention(f.tenantId);
    expect(await f.platform.credentialShareLink.count({ where: { id: old } })).toBe(0);
    expect(await f.platform.credentialShareLink.count({ where: { id: recent } })).toBe(1);
    expect(await counts(bare)).toEqual({ item: 0, secret: 0, versions: 0, links: 0 });
    expect(await counts(gone)).toEqual({ item: 0, secret: 0, versions: 0, links: 0 });
    expect(run.released).toBeGreaterThanOrEqual(1);
    expect(run.deleted).toBeGreaterThanOrEqual(1);
    // …and the sweep writes no audit row: the link's life is its evidence.
    expect(await f.platform.auditEvent.count({ where: { tenantId: f.tenantId, targetId: old } })).toBe(0);
  });
});

describe("the job's runs", () => {
  it("two runs at once erase each login once, and audit it once", async () => {
    const a = await madeLogin("Race A", { link: false });
    const b = await madeLogin("Race B");
    const s = await sentLogin("Race sent");
    for (const id of [a, b, s.id]) await binned(id, 31);
    await Promise.all([purgeVaultRetention(f.tenantId), purgeVaultRetention(f.tenantId)]);
    for (const id of [a, b, s.id]) expect(await purgedRows(id), id).toHaveLength(1);
    expect((await counts(a)).item).toBe(0);
    expect(await counts(b)).toEqual({ item: 1, secret: 0, versions: 0, links: 1 });
    expect(await counts(s.id)).toEqual({ item: 1, secret: 0, versions: 0, links: 1 });
  });

  it("a row another transaction holds is skipped, not waited on — and taken by the next run", async () => {
    const held = await madeLogin("Held", { link: false });
    const free = await madeLogin("Free", { link: false });
    await binned(held, 31);
    await binned(free, 31);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockedNow = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = withTenant(
      f.tenantId,
      { type: "system" },
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM credential_item WHERE id = ${held} FOR UPDATE`;
        locked();
        await released;
      },
      { timeoutMs: 60_000 },
    );
    await lockedNow;
    try {
      // Waiting on the held row would spend the bin's lock bound and fail
      // the run (VAULT_BUSY, rethrown after the other phases); skipping it
      // lets the run finish and erase the rest.
      await purgeVaultRetention(f.tenantId);
      expect((await counts(held)).item).toBe(1);
      expect((await counts(free)).item).toBe(0);
    } finally {
      release();
      await holder;
    }
    await purgeVaultRetention(f.tenantId);
    expect((await counts(held)).item).toBe(0);
  }, 60_000);

  it("a run spans batches: 120 logins due are all erased", async () => {
    const ids = Array.from({ length: 120 }, () => randomUUID());
    await f.platform.credentialItem.createMany({
      data: ids.map((id, i) => ({
        id,
        tenantId: f.tenantId,
        type: "LOGIN" as const,
        name: `Bulk ${i} ${RUN}`,
        deletedAt: daysAgo(40),
      })),
    });
    const run = await purgeVaultRetention(f.tenantId);
    expect(run.deleted).toBeGreaterThanOrEqual(120);
    expect(await f.platform.credentialItem.count({ where: { id: { in: ids } } })).toBe(0);
    expect(
      await f.platform.auditEvent.count({ where: { tenantId: f.tenantId, action: "credential.purged", targetId: { in: ids } } }),
    ).toBe(120);
  });

  it("the vault module switched off does not pause it", async () => {
    const due = await madeLogin("Module off", { link: false });
    await binned(due, 31);
    await setModuleEnabled(ownerCtx(), "vault", false);
    try {
      await purgeVaultRetention(f.tenantId);
    } finally {
      await setModuleEnabled(ownerCtx(), "vault", true);
    }
    expect((await counts(due)).item).toBe(0);
  });

  it("a member's removal flags what they knew and never trips over an erased login", async () => {
    // The manager looked at a login a client sent; it was binned and erased.
    const sent = await sentLogin("Known");
    await revealCredentialField(managerCtx(), sent.id, "password");
    await binned(sent.id, 31);
    await purgeVaultRetention(f.tenantId);
    // …and a live login they also looked at.
    const live = await madeLogin("Known live");
    await revealCredentialField(managerCtx(), live, "password");
    const flagged = await asSystem((tx) => flagLoginsKnownBy(tx, f.tenantId, f.seats.manager.memberId));
    expect(flagged).toBe(1);
    expect((await f.platform.credentialItem.findUniqueOrThrow({ where: { id: live } })).needsRotation).toBe(true);
    expect((await f.platform.credentialItem.findUniqueOrThrow({ where: { id: sent.id } })).needsRotation).toBe(false);
  });
});
