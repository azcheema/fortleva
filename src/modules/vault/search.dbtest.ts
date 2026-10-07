import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AGENCY_WHERE } from "@/app/(tenant)/(authed)/vault/surface";
import type { MemberActor } from "@/authz/authorize";
import { resetTenantDekCache } from "@/crypto/tenant-key";
import { withTenant } from "@/db";
import { actorFor, noMfa, setupTenant } from "@/members/dbtest-fixture";
import { setModuleEnabled } from "@/preferences/service";
import { search, type SearchHit } from "@/search/query";

import { createCredential, deleteCredential, updateCredential } from "./index";

/**
 * LOGINS IN SEARCH (Phase 3V slice 97; founder decision C65), against the
 * real database and the real app_runtime role. What is at stake:
 *
 *   1. THE INDEX HOLDS NO SECRET AND NO NOTE. Migration 20261007120000
 *      feeds a login's name, username, web address and tags — and the
 *      words and parent domains it derives from them — and nothing else.
 *   2. THE DOOR. Logins are in an answer only while the member's vault is
 *      open (C52 (a)); a member who could open it is told it is locked on
 *      EVERY search; a member who could not — viewing as someone else,
 *      the module off — is never told anything about logins.
 *   3. THE VAULT'S REACH (C49), hand-applied in SQL and re-checked on the
 *      live row: our own logins to a tenant-wide scope only, a client's
 *      own logins to a DIRECT assignment only, a project's through the
 *      project axis.
 *   4. NO CONTACT READS A LOGIN'S INDEX ROW — not even for a login shown
 *      to their client.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
let acmeP1: string;
let acmeP2: string;
let betaP: string;

const RUN = randomUUID().slice(0, 8);
/** Words in no dictionary, so a match is never incidental. */
const tok = `zqxwv${RUN}`;
const SECRET = `Hunter-pw-${RUN}-zq!`;
const NOTE_WORD = `notecanary${RUN}`;

const owner = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) });
const employee = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.employee.memberId) });
const withActor = (actor: MemberActor) => ({ tenantId: f.tenantId, actor });
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

/** The answer, asserted to be one. */
const answer = async (ctx: { tenantId: string; actor: MemberActor }, q: string) => {
  const out = await search(ctx, q);
  if (out.kind !== "results") throw new Error(`"${q}" was not a usable query`);
  return out;
};
const logins = async (ctx: { tenantId: string; actor: MemberActor }, q: string): Promise<SearchHit[]> =>
  (await answer(ctx, q)).hits.filter((h) => h.entityType === "CREDENTIAL_ITEM");
const loginIds = async (ctx: { tenantId: string; actor: MemberActor }, q: string) =>
  (await logins(ctx, q)).map((h) => h.entityId).sort();

const indexRow = async (id: string) =>
  (
    await f.platform.$queryRaw<
      {
        title: string;
        subtitle: string | null;
        body_text: string | null;
        meta_text: string | null;
        visibility: string;
        portal_enabled: boolean;
        client_id: string | null;
        project_id: string | null;
        doc: string;
      }[]
    >`SELECT title, subtitle, body_text, meta_text, visibility::text AS visibility, portal_enabled,
             client_id, project_id, search::text AS doc
        FROM search_index
       WHERE tenant_id = ${f.tenantId} AND entity_type = 'CREDENTIAL_ITEM' AND entity_id = ${id}`
  )[0];

/** One login per anchor, all findable by `tok`. */
let own: string;
let acmeLevel: string;
let acmeP1Login: string;
let acmeP2Login: string;
let betaLevel: string;
let betaPLogin: string;
/** Each login's own word. */
let words: Map<string, string>;
/** The logins of the six this actor finds, each asked by its own word. */
const reached = async (ctx: { tenantId: string; actor: MemberActor }) => {
  const out: string[] = [];
  for (const [id, word] of words) if ((await loginIds(ctx, word)).includes(id)) out.push(id);
  return out.sort();
};

beforeAll(async () => {
  f = await setupTenant("vfind");
  acme = randomUUID();
  beta = randomUUID();
  acmeP1 = randomUUID();
  acmeP2 = randomUUID();
  betaP = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme" },
      { id: beta, tenantId: f.tenantId, name: "Beta" },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: acmeP1, tenantId: f.tenantId, clientId: acme, key: "FNA", name: "Acme site" },
      { id: acmeP2, tenantId: f.tenantId, clientId: acme, key: "FNB", name: "Acme app" },
      { id: betaP, tenantId: f.tenantId, clientId: beta, key: "FNC", name: "Beta site" },
    ],
  });
  // The employee works on ONE project of Acme, and on Beta directly.
  await f.platform.memberProject.create({
    data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId: acmeP1 },
  });
  await f.platform.memberClient.create({
    data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: beta },
  });

  // Each also has a word of its own: an answer holds at most
  // PER_TYPE_LIMIT (5) logins, so six are never asked for at once.
  const make = async (anchor: { clientId?: string; projectId?: string }, word: string) =>
    (await createCredential(owner(), { ...anchor, type: "LOGIN", name: `${word}${RUN} ${tok}`, secret: { password: SECRET } })).id;
  own = await make({}, "registrar");
  acmeLevel = await make({ clientId: acme }, "acmehosting");
  acmeP1Login = await make({ projectId: acmeP1 }, "acmesite");
  acmeP2Login = await make({ projectId: acmeP2 }, "acmeapp");
  betaLevel = await make({ clientId: beta }, "betadns");
  betaPLogin = await make({ projectId: betaP }, "betasite");
  words = new Map([
    [own, `registrar${RUN}`],
    [acmeLevel, `acmehosting${RUN}`],
    [acmeP1Login, `acmesite${RUN}`],
    [acmeP2Login, `acmeapp${RUN}`],
    [betaLevel, `betadns${RUN}`],
    [betaPLogin, `betasite${RUN}`],
  ]);
}, 120_000);

afterAll(async () => {
  if (f) {
    await f.platform.credentialItem.deleteMany({ where: { tenantId: f.tenantId } }); // secrets + versions cascade
    await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  }
  resetTenantDekCache();
  await f?.cleanup();
}, 120_000);

describe("the feed — what a login's index row holds", () => {
  it("its name, username, web address and tags — never the notes, never the secret", async () => {
    const word = `fieldsx${RUN}`;
    const id = (
      await createCredential(owner(), {
        clientId: acme,
        type: "LOGIN",
        name: `Mail ${word}`,
        username: `anna${RUN}@acme${RUN}.test`,
        url: `https://www.host${RUN}.test/wp-admin/`,
        tags: [`tag${RUN}`],
        notes: `The old one was ${NOTE_WORD}`,
        secret: { password: SECRET },
      })
    ).id;
    const row = await indexRow(id);
    expect(row, "a live login is indexed").toBeDefined();
    expect(row!.title).toBe(`Mail ${word}`);
    // INTERNAL whatever the login says, and no portal stamp: the portal
    // never searches logins (the migration's header).
    expect(row!.visibility).toBe("INTERNAL");
    expect(row!.portal_enabled).toBe(false);
    // The place line is resolved live by the reader, never baked in.
    expect(row!.subtitle).toBeNull();
    expect(row!.body_text).toBeNull();
    expect(row!.client_id).toBe(acme);
    expect(row!.project_id).toBeNull();
    for (const part of [`anna${RUN}@acme${RUN}.test`, `https://www.host${RUN}.test/wp-admin/`, `tag${RUN}`]) {
      expect(row!.meta_text).toContain(part);
    }
    // Nothing of the notes, nothing of the secret — in any column, the
    // generated tsvector included.
    const all = JSON.stringify(row);
    expect(all).not.toContain(NOTE_WORD);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(`Hunter`);

    // And what each part is FOUND by (the migration measured the parser
    // keeping an address and an email whole).
    const findsBy = async (q: string) => (await loginIds(owner(), q)).includes(id);
    expect(await findsBy(word), "the name").toBe(true);
    expect(await findsBy(`anna${RUN}@acme${RUN}.test`), "the whole username").toBe(true);
    expect(await findsBy(`anna${RUN}`), "a word of the username").toBe(true);
    expect(await findsBy(`host${RUN}.test`), "a parent domain of the address").toBe(true);
    expect(await findsBy(`www.host${RUN}.test`), "the address's host").toBe(true);
    expect(await findsBy(`acme${RUN}.test`), "the username's domain").toBe(true);
    expect(await findsBy(`host${RUN}`), "a word of the address").toBe(true);
    expect(await findsBy(`tag${RUN}`), "a tag").toBe(true);
    expect(await findsBy(NOTE_WORD), "never the notes").toBe(false);
    expect((await answer(owner(), "https")).hits.some((h) => h.entityId === id), "the scheme is not a word").toBe(false);
  });

  it("follows a rename, a new username and a move; the bin and a delete take it out", async () => {
    const before = `renamebefore${RUN}`;
    const after = `renameafter${RUN}`;
    const id = (await createCredential(owner(), { clientId: acme, type: "LOGIN", name: before, secret: { password: SECRET } })).id;
    expect(await loginIds(owner(), before)).toContain(id);

    await updateCredential(owner(), id, { name: after, username: `newuser${RUN}` });
    expect(await loginIds(owner(), before)).not.toContain(id);
    expect(await loginIds(owner(), after)).toContain(id);
    expect(await loginIds(owner(), `newuser${RUN}`)).toContain(id);

    // A move (no service moves a login today; the feed must still follow
    // its anchor, which the reader's scope term reads).
    await f.platform.credentialItem.update({ where: { id }, data: { clientId: beta } });
    expect((await indexRow(id))!.client_id).toBe(beta);

    // The bin: the service's delete is a soft delete.
    await deleteCredential(owner(), id);
    expect(await indexRow(id), "a binned login leaves the index").toBeUndefined();
    expect(await loginIds(owner(), after)).not.toContain(id);

    // Back out of the bin (raw — there is no restore yet), then a hard delete.
    await f.platform.credentialItem.update({ where: { id }, data: { deletedAt: null } });
    expect(await indexRow(id), "out of the bin, back in the index").toBeDefined();
    await f.platform.credentialItem.delete({ where: { id } });
    expect(await indexRow(id), "a deleted login leaves the index").toBeUndefined();
  });
});

describe("the door (C52 (a), C65 (a))", () => {
  it("logins are found only while the vault is open", async () => {
    expect(await reached(owner())).toEqual([own, acmeLevel, acmeP1Login, acmeP2Login, betaLevel, betaPLogin].sort());
    // Open, with the window's end: the factor's stamp plus the vault's
    // ten minutes — the instant a page showing a login must lock at.
    const before = Date.now();
    const open = await answer(owner(), tok);
    expect(open.vault.state).toBe("open");
    const locksAt = open.vault.state === "open" ? open.vault.locksAt.getTime() : 0;
    expect(locksAt).toBeGreaterThan(before + 9 * 60_000);
    expect(locksAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
  });

  it("a stale factor, or none: no login — and the hint, on any query, matching or not", async () => {
    for (const actor of [
      { memberId: f.seats.owner.memberId, mfa: { enrolled: true, verifiedAt: minutesAgo(20) } },
      noMfa(f.seats.owner.memberId),
    ] satisfies MemberActor[]) {
      const locked = await answer(withActor(actor), tok);
      expect(locked.hits.filter((h) => h.entityType === "CREDENTIAL_ITEM")).toEqual([]);
      expect(locked.vault).toEqual({ state: "locked" });
      // Everything else still answers: the client card "Acme" is found by
      // its name while the vault is locked.
      expect((await answer(withActor(actor), "Acme")).hits.some((h) => h.entityType === "CLIENT")).toBe(true);
      // A query no login matches says the same — the line is never a
      // sign that a login matched.
      const unmatched = await answer(withActor(actor), `nothinghere${RUN}`);
      expect(unmatched.hits).toEqual([]);
      expect(unmatched.vault).toEqual({ state: "locked" });
    }
  });

  it("viewing as someone else: no login, and no hint — impersonation never opens the vault", async () => {
    const imp: MemberActor = { ...actorFor(f.seats.owner.memberId), impersonated: true };
    const out = await answer(withActor(imp), tok);
    expect(out.hits.filter((h) => h.entityType === "CREDENTIAL_ITEM")).toEqual([]);
    expect(out.vault).toEqual({ state: "closed" });
  });

  it("the vault module off: no login, and no hint", async () => {
    await setModuleEnabled(owner(), "vault", false);
    try {
      const out = await answer(owner(), tok);
      expect(out.hits.filter((h) => h.entityType === "CREDENTIAL_ITEM")).toEqual([]);
      expect(out.vault).toEqual({ state: "closed" });
    } finally {
      await setModuleEnabled(owner(), "vault", true);
    }
    expect(await reached(owner())).toHaveLength(6);
  });
});

describe("the vault's reach (C49), in the query and on the live row", () => {
  it("a scoped member finds a project's logins through the project, a client's own only when assigned to it directly, and never ours", async () => {
    // Employee: MemberProject on Acme's P1, MemberClient on Beta.
    expect(await reached(employee())).toEqual([acmeP1Login, betaLevel, betaPLogin].sort());
    // And through one word they all share — with more of OUR OWN logins
    // than an answer holds of a type (PER_TYPE_LIMIT, 5), all newer, so
    // they would rank first. The reach is a TERM IN THE SQL: were it only
    // the hydrate's, the cap would fill with ours, the hydrate would drop
    // them, and the employee would get NO login (the code review's gap —
    // the hydrate belt alone hid it).
    for (let i = 0; i < 6; i++) {
      await createCredential(owner(), { type: "LOGIN", name: `Crowd ${i} ${tok}`, secret: { password: SECRET } });
    }
    expect(await loginIds(employee(), tok)).toEqual([acmeP1Login, betaLevel, betaPLogin].sort());
  });

  it("each hit opens where the login lives, under its place", async () => {
    const hitOf = async (id: string) => (await logins(owner(), words.get(id)!)).find((h) => h.entityId === id);
    const byId = new Map([own, acmeLevel, acmeP1Login].map((id) => [id, null as SearchHit | null | undefined]));
    for (const id of byId.keys()) byId.set(id, await hitOf(id));
    expect(byId.get(own)).toMatchObject({ href: `/vault?client=${AGENCY_WHERE}#credential-${own}`, subtitle: null });
    // A client's logins, its own and its projects', open on /vault's view of
    // that client — which needs nothing but the door (the reviews: the
    // client's and project's tabs also need client:view / project:view).
    expect(byId.get(acmeLevel)).toMatchObject({ href: `/vault?client=${acme}#credential-${acmeLevel}`, subtitle: "Acme" });
    expect(byId.get(acmeP1Login)).toMatchObject({ href: `/vault?client=${acme}#credential-${acmeP1Login}`, subtitle: "FNA" });

    // The place is read live: a client's rename fires no login feed.
    await f.platform.client.update({ where: { id: acme }, data: { name: "Acme Renamed" } });
    try {
      expect((await hitOf(acmeLevel))?.subtitle).toBe("Acme Renamed");
    } finally {
      await f.platform.client.update({ where: { id: acme }, data: { name: "Acme" } });
    }
  });

  it("the live row decides, not the index's copy of the anchor (the hydrate belt)", async () => {
    // Make our own login's index row CLAIM to be Beta's — a client the
    // employee is assigned to directly — as a stale or tampered index
    // would. The query lets it through; the live row must not.
    await f.platform.$executeRaw`
      UPDATE search_index SET client_id = ${beta}
       WHERE tenant_id = ${f.tenantId} AND entity_type = 'CREDENTIAL_ITEM' AND entity_id = ${own}`;
    try {
      expect(await loginIds(employee(), words.get(own)!)).not.toContain(own);
      expect(await loginIds(owner(), words.get(own)!)).toContain(own);
    } finally {
      await f.platform.$executeRaw`
        UPDATE search_index SET client_id = NULL
         WHERE tenant_id = ${f.tenantId} AND entity_type = 'CREDENTIAL_ITEM' AND entity_id = ${own}`;
    }
  });

  it("a binned login whose index row lingers is not returned", async () => {
    const word = `lingers${RUN}`;
    const id = (await createCredential(owner(), { clientId: acme, type: "LOGIN", name: word, secret: { password: SECRET } })).id;
    await deleteCredential(owner(), id);
    // Put the row back, as a missed feed would leave it.
    await f.platform.$executeRaw`
      INSERT INTO search_index (tenant_id, entity_type, entity_id, client_id, project_id, title, lang)
      VALUES (${f.tenantId}, 'CREDENTIAL_ITEM', ${id}, ${acme}, NULL, ${word}, search_lang(${f.tenantId}))`;
    expect(await indexRow(id)).toBeDefined();
    expect(await loginIds(owner(), word)).toEqual([]);
  });
});

describe("the feed's bounds and the migration's own backfill", () => {
  it("the longest address and username anyone may type save, and their index text stays small (the pre-apply review's medium)", async () => {
    // A 2048-character address of one-letter labels: every suffix of its
    // host used to become a lexeme — about 1 MB of index text, past
    // tsvector's cap, so the feed THREW and the write failed. A client can
    // hand such a login over through the portal (slice 96).
    const url = `https://${"a.".repeat(1019)}se`;
    const username = `u@${"b.".repeat(157)}se`;
    expect(url).toHaveLength(2048);
    const tags = Array.from({ length: 20 }, (_, i) => `t${i}`.padEnd(50, "x"));
    const id = (
      await createCredential(owner(), { clientId: acme, type: "LOGIN", name: `Longest ${RUN}`, username, url, tags, secret: { password: SECRET } })
    ).id;
    const row = await indexRow(id);
    expect(row).toBeDefined();
    expect(row!.meta_text!.length).toBeLessThan(8192);
    // A host longer than a DNS name may be is not expanded at all.
    expect(row!.meta_text).not.toMatch(/ a\.se( |$)/);
    expect(row!.meta_text).not.toMatch(/ b\.se( |$)/);

    // A real one gets its last three parent domains, never every one.
    const deep = (
      await createCredential(owner(), { clientId: acme, type: "LOGIN", name: `Deep ${RUN}`, url: "https://a.b.c.d.e.example.test/", secret: { password: SECRET } })
    ).id;
    const meta = ` ${(await indexRow(deep))!.meta_text} `;
    for (const host of ["a.b.c.d.e.example.test", "d.e.example.test", "e.example.test", "example.test"]) expect(meta).toContain(` ${host} `);
    expect(meta).not.toContain(" c.d.e.example.test ");

    // A long email domain is found whole too: the parser keeps only the
    // whole address as a word, so the host itself is one of the four.
    const mail = (
      await createCredential(owner(), { clientId: acme, type: "LOGIN", name: `Mailbox ${RUN}`, username: `anna@mail${RUN}.dept.uni.ac.test`, secret: { password: SECRET } })
    ).id;
    expect(await loginIds(owner(), `mail${RUN}.dept.uni.ac.test`)).toContain(mail);

    // Tags: the database bounds how many, not how long — a writer that
    // skips the service's `normalizeTags` must not grow the row.
    await f.platform.credentialItem.update({
      where: { id: mail },
      data: { tags: Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(5000, "q")) },
    });
    expect((await indexRow(mail))!.meta_text!.length).toBeLessThan(8192);
  });

  it("an address's query string and fragment are never indexed — a reset link's token is not a search word", async () => {
    const token = `resettoken${RUN}`;
    const id = (
      await createCredential(owner(), {
        clientId: acme,
        type: "LOGIN",
        name: `Reset link ${RUN}`,
        url: `https://portal.example.test/reset?key=${token}#frag${RUN}`,
        secret: { password: SECRET },
      })
    ).id;
    const row = await indexRow(id);
    expect(row!.meta_text).toContain("https://portal.example.test/reset");
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(`frag${RUN}`);
    expect(await loginIds(owner(), token)).toEqual([]);
  });

  it("only a change to what a login is FOUND BY re-feeds it — a flag or a show writes no index row", async () => {
    const id = (await createCredential(owner(), { clientId: acme, type: "LOGIN", name: `Quiet ${RUN}`, secret: { password: SECRET } })).id;
    const fedAt = async () =>
      (
        await f.platform.$queryRaw<{ at: Date }[]>`
          SELECT updated_at AS at FROM search_index
           WHERE tenant_id = ${f.tenantId} AND entity_type = 'CREDENTIAL_ITEM' AND entity_id = ${id}`
      )[0]?.at.getTime();
    const before = await fedAt();
    expect(before).toBeDefined();
    // Prisma stamps updated_at on both: neither is a column the row is built from.
    await f.platform.credentialItem.update({ where: { id }, data: { needsRotation: true } });
    await f.platform.credentialItem.update({ where: { id }, data: { visibility: "CLIENT_VISIBLE" } });
    expect(await fedAt()).toBe(before);
    await f.platform.credentialItem.update({ where: { id }, data: { visibility: "INTERNAL", needsRotation: false } });
  });

  it("THE MIGRATION'S OWN BACKFILL, run against real rows — CI applies it to an empty database", async () => {
    // Read out of the .sql file so it cannot drift from what shipped, and
    // narrowed to THIS tenant: the dev database is shared, and the
    // statement as written fills every tenant's missing rows.
    const sql = readFileSync(join(process.cwd(), "prisma/migrations/20261007120000_search_feed_credential/migration.sql"), "utf8");
    const start = sql.indexOf("INSERT INTO search_index");
    expect(start).toBeGreaterThan(0);
    const statement = sql.slice(start, sql.indexOf(";", start));
    expect(statement).not.toMatch(/NEW\.|OLD\./);
    const anchor = "WHERE ci.deleted_at IS NULL";
    expect(statement.split(anchor)).toHaveLength(2);
    const scoped = statement.replace(anchor, `${anchor} AND ci.tenant_id = '${f.tenantId}'`);

    const full = (
      await createCredential(owner(), {
        projectId: acmeP1,
        type: "LOGIN",
        name: `Backfilled ${RUN}`,
        username: `ops${RUN}@backfill.test`,
        url: `https://admin.backfill${RUN}.test/x`,
        tags: [`bf${RUN}`],
        secret: { password: SECRET },
      })
    ).id;
    const binned = (await createCredential(owner(), { clientId: acme, type: "LOGIN", name: `Binned ${RUN}`, secret: { password: SECRET } })).id;
    await deleteCredential(owner(), binned);
    const expected = await indexRow(full);
    // The state before the migration: no index row for either.
    await f.platform.$executeRaw`
      DELETE FROM search_index WHERE tenant_id = ${f.tenantId} AND entity_type = 'CREDENTIAL_ITEM' AND entity_id IN (${full}, ${binned})`;
    expect(await indexRow(full)).toBeUndefined();

    await f.platform.$executeRawUnsafe(scoped);

    const filled = await indexRow(full);
    // The same row the feed writes — title, anchor, the derived text, INTERNAL —
    expect(filled).toEqual(expected);
    // — stemmed in the tenant's language, and as recent as the login itself.
    const [stamp] = await f.platform.$queryRaw<{ same_lang: boolean; same_time: boolean }[]>`
      SELECT si.lang = search_lang(${f.tenantId}) AS same_lang, si.updated_at = ci.updated_at AS same_time
        FROM search_index si JOIN credential_item ci ON ci.tenant_id = si.tenant_id AND ci.id = si.entity_id
       WHERE si.tenant_id = ${f.tenantId} AND si.entity_type = 'CREDENTIAL_ITEM' AND si.entity_id = ${full}`;
    expect(stamp).toEqual({ same_lang: true, same_time: true });
    // A binned login is not brought back.
    expect(await indexRow(binned)).toBeUndefined();
    // And a second run is a no-op.
    await f.platform.$executeRawUnsafe(scoped);
    expect(await indexRow(full)).toEqual(expected);
  });
});

describe("no contact reads a login's index row (the portal never searches logins)", () => {
  const contactOf = async (clientId: string) => {
    const contactId = randomUUID();
    await f.platform.contact.create({
      data: {
        id: contactId,
        tenantId: f.tenantId,
        clientId,
        name: "Main contact",
        email: `main-${contactId.slice(0, 8)}@test.invalid`,
        portalProfile: "CONTACT_PRIMARY",
        portalStatus: "ACTIVE",
        invitedAt: new Date("2026-09-01T09:00:00Z"),
        emailVerified: true,
      },
    });
    return contactId;
  };
  const contactCount = (contactId: string, clientId: string) =>
    withTenant(f.tenantId, { type: "contact", id: contactId, clientId }, async (tx) => {
      const rows = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM search_index WHERE entity_type = 'CREDENTIAL_ITEM'`;
      return rows[0]?.n ?? -1;
    });

  it("zero rows — even for a login shown to their client", async () => {
    // Shown to the client, as slice 91's "Show to client…" leaves it. A
    // visibility change re-feeds nothing; the row was INTERNAL and stays so.
    await f.platform.credentialItem.update({ where: { id: acmeLevel }, data: { visibility: "CLIENT_VISIBLE" } });
    try {
      expect((await indexRow(acmeLevel))!.visibility).toBe("INTERNAL");
      const contact = await contactOf(acme);
      expect(await contactCount(contact, acme)).toBe(0);
      // The control: the SAME contact reads the row once it says
      // CLIENT_VISIBLE — so the zero above is the INTERNAL, not a fixture
      // that could never see anything.
      await f.platform.$executeRaw`
        UPDATE search_index SET visibility = 'CLIENT_VISIBLE'
         WHERE tenant_id = ${f.tenantId} AND entity_type = 'CREDENTIAL_ITEM' AND entity_id = ${acmeLevel}`;
      try {
        expect(await contactCount(contact, acme)).toBe(1);
      } finally {
        await f.platform.$executeRaw`
          UPDATE search_index SET visibility = 'INTERNAL'
           WHERE tenant_id = ${f.tenantId} AND entity_type = 'CREDENTIAL_ITEM' AND entity_id = ${acmeLevel}`;
      }
    } finally {
      await f.platform.credentialItem.update({ where: { id: acmeLevel }, data: { visibility: "INTERNAL" } });
    }
  });

  it("zero rows for a shown login on a portal-ON project, its row stamped `portal_enabled` as the switch's fan-out does", async () => {
    // The fan-out and the reconcile re-derive `portal_enabled` on EVERY
    // index row of a project, a login's included (the review's low): the
    // INTERNAL alone must hold the gate.
    const portalProject = randomUUID();
    await f.platform.project.create({
      data: { id: portalProject, tenantId: f.tenantId, clientId: acme, key: "FNP", name: "Acme portal", portalEnabled: true },
    });
    const id = (await createCredential(owner(), { projectId: portalProject, type: "LOGIN", name: `On portal ${RUN}`, secret: { password: SECRET } })).id;
    await f.platform.credentialItem.update({ where: { id }, data: { visibility: "CLIENT_VISIBLE" } });
    await f.platform.$executeRaw`
      UPDATE search_index SET portal_enabled = true
       WHERE tenant_id = ${f.tenantId} AND entity_type = 'CREDENTIAL_ITEM' AND entity_id = ${id}`;
    const row = await indexRow(id);
    expect(row).toMatchObject({ visibility: "INTERNAL", portal_enabled: true, project_id: portalProject });
    const contact = await contactOf(acme);
    expect(await contactCount(contact, acme)).toBe(0);
    // The control: the three-term gate's other two terms are met, so the
    // row turns readable the moment it says CLIENT_VISIBLE.
    await f.platform.$executeRaw`
      UPDATE search_index SET visibility = 'CLIENT_VISIBLE'
       WHERE tenant_id = ${f.tenantId} AND entity_type = 'CREDENTIAL_ITEM' AND entity_id = ${id}`;
    try {
      expect(await contactCount(contact, acme)).toBe(1);
    } finally {
      await f.platform.$executeRaw`
        DELETE FROM search_index WHERE tenant_id = ${f.tenantId} AND entity_type = 'CREDENTIAL_ITEM' AND entity_id = ${id}`;
    }
  });
});

