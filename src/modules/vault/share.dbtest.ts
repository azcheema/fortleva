import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { resetTenantDekCache } from "@/crypto/tenant-key";
import { withTenant } from "@/db";
import { parseEntitlements } from "@/entitlements/resolver";
import { DomainError } from "@/lib/domain-error";
import { setTransport, type MailTransport } from "@/mailer";
import { actorFor, maskIds, setupTenant } from "@/members/dbtest-fixture";
import { setModuleEnabled, updatePreferences } from "@/preferences/service";
import { resetLocalLimiter } from "@/ratelimit";

import {
  createCredential,
  createShareLink,
  deleteCredential,
  listShareLinks,
  openShareLink,
  previewShareLink,
  replaceCredentialSecret,
  revokeShareLink,
  sendShareCode,
  type ShareCodeMail,
} from "./index";
import { REVEAL_ACTIONS } from "./budget";
import { hashShareCode, mintShareToken, parseShareToken } from "./share-token";

/**
 * SHARE LINKS against the real database and the real app_runtime role
 * (Phase 3V slice 90). PLAN Phase 3V's owed non-negotiables this slice
 * reaches:
 *   - share-link view-once: two opens with the right code at once → ONE
 *     secret;
 *   - an employee cannot share;
 *   - the code's brute-force bound: five checks per link, ever;
 *   - the token's hash only at rest, the TTL enforced;
 * (and `withPlatform` unreachable from the share route — a graph walk,
 * `src/portal/share-route-boundary.test.ts`). Plus: the always-fresh
 * factor, scope, the workspace switches, a secret changed or deleted
 * since, revoke, the list, the guard's who-writes-what, a contact's zero
 * rows, and that no table or audit row holds the token, the code or the
 * address.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let other: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let login: string; // Acme, client-level, LOGIN with a password and a username
let apiKey: string; // Acme, API_KEY with apiKey only
let otherLogin: string; // the other tenant's
let sharerUserId: string | null = null; // the custom-role member's user (cleaned up below)

const RUN = randomUUID().slice(0, 8);
const PASSWORD = `Share-pw-${RUN}-zq!`;
const RECIPIENT = `bob-${RUN}@example.test`;

const owner = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) });
const manager = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.manager.memberId) });
const admin = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.admin.memberId) });
const employee = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.employee.memberId) });
const withActor = (actor: MemberActor) => ({ tenantId: f.tenantId, actor });
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason === "MFA_REQUIRED" ? `MFA_REQUIRED:${e.mfaRemedy}` : e.reason;
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

/** Mail is captured here: the code reaches the test the way it reaches a person. */
const mailbox: { to: string; subject: string; text: string }[] = [];
let previousTransport: MailTransport;
const compose: ShareCodeMail = ({ code, tenantName, minutes }) => ({
  subject: `Code for a login from ${tenantName}`,
  text: `code ${code} for ${minutes} minutes`,
});
const lastCodeTo = (to: string): string => {
  const mail = mailbox.filter((m) => m.to === to).at(-1);
  const code = mail?.text.match(/code (\d{6})/)?.[1];
  if (!code) throw new Error(`no code mailed to ${to}`);
  return code;
};

/** A fresh link to Acme's login, as the owner; its token. */
const share = async (overrides: Partial<Parameters<typeof createShareLink>[2]> = {}) => {
  const created = await createShareLink(owner(), login, {
    field: "password",
    recipientEmail: RECIPIENT,
    expiresInHours: 24,
    includeUsername: true,
    ...overrides,
  });
  const token = created.url.slice(created.url.indexOf("/portal/share/") + "/portal/share/".length);
  return { ...created, token };
};

/** A link's row, read past RLS (setup and assertions only). */
const row = (id: string) => f.platform.credentialShareLink.findUniqueOrThrow({ where: { id } });

/** The secret's version, read past RLS. */
const secretVersion = async (credentialId: string) =>
  (await f.platform.credentialSecret.findUniqueOrThrow({ where: { credentialId }, select: { version: true } })).version;

beforeAll(async () => {
  f = await setupTenant("vlink");
  other = await setupTenant("vlink");
  acme = randomUUID();
  await f.platform.client.create({ data: { id: acme, tenantId: f.tenantId, name: "Acme" } });
  const otherAcme = randomUUID();
  await other.platform.client.create({ data: { id: otherAcme, tenantId: other.tenantId, name: "Other Acme" } });
  login = (
    await createCredential(owner(), {
      clientId: acme,
      type: "LOGIN",
      name: "Acme hosting",
      username: "acme-admin",
      url: "https://panel.example.test",
      secret: { password: PASSWORD },
    })
  ).id;
  apiKey = (
    await createCredential(owner(), {
      clientId: acme,
      type: "API_KEY",
      name: "Acme API",
      secret: { apiKey: `key-${RUN}` },
    })
  ).id;
  otherLogin = (
    await createCredential(
      { tenantId: other.tenantId, actor: actorFor(other.seats.owner.memberId) },
      { clientId: otherAcme, type: "LOGIN", name: "Theirs", secret: { password: "x" } },
    )
  ).id;
  previousTransport = setTransport(async (msg) => {
    mailbox.push({ to: msg.to, subject: msg.subject, text: msg.text });
  });
  // Every link is one of its maker's reveals for the hour (slice 90's
  // security review), and this file makes dozens as the owner: the budget
  // at its ceiling, and the one test about it lowers it on purpose.
  await updatePreferences(owner(), { vault: { revealBudgetPerHour: 100 } });
}, 180_000);

// The per-address code bucket (`vault.share_code_to`) is in-process; each
// test starts with it empty, and the test about it spends it on purpose.
beforeEach(() => resetLocalLimiter());

afterAll(async () => {
  if (previousTransport) setTransport(previousTransport);
  if (f && sharerUserId) {
    await f.platform.memberRole.deleteMany({ where: { tenantId: f.tenantId, member: { userId: sharerUserId } } });
    await f.platform.member.deleteMany({ where: { tenantId: f.tenantId, userId: sharerUserId } });
    await f.platform.user.deleteMany({ where: { id: sharerUserId } });
  }
  for (const t of [f, other]) {
    if (!t) continue;
    // Share links go with their login (FK cascade); secrets and versions too.
    await t.platform.credentialItem.deleteMany({ where: { tenantId: t.tenantId } });
    await t.platform.client.deleteMany({ where: { tenantId: t.tenantId } });
    await t.platform.tenantPreference.deleteMany({ where: { tenantId: t.tenantId } });
    await t.platform.tenantKey.deleteMany({ where: { tenantId: t.tenantId } });
  }
  resetTenantDekCache();
  await other?.cleanup();
  await f?.cleanup();
}, 180_000);

describe("making a link — credential:share ✦, always a fresh factor", () => {
  it("owner, manager and admin may; the link comes back once and only its hash is kept", async () => {
    const created = await share({ recipientEmail: `  Bob-${RUN}@Example.TEST ` });
    expect(created.url).toMatch(/\/portal\/share\/[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const parsed = parseShareToken(created.token)!;
    expect(parsed.tenantId).toBe(f.tenantId);
    const stored = await row(created.id);
    expect(stored.tokenHash).toBe(parsed.tokenHash);
    expect(stored.recipientEmail).toBe(RECIPIENT);
    expect(stored.secretVersion).toBe(await secretVersion(login));
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(24 * 3_600_000);
    // Nothing that opens it is stored: not the random part, not the token.
    expect(JSON.stringify(stored)).not.toContain(created.token.slice(37));
    expect(
      await outcome(createShareLink(manager(), login, { field: "password", recipientEmail: RECIPIENT, expiresInHours: 1, includeUsername: false })),
    ).toBe("ok");
    expect(await outcome(createShareLink({ tenantId: f.tenantId, actor: actorFor(f.seats.admin.memberId) }, login, {
      field: "password", recipientEmail: RECIPIENT, expiresInHours: 1, includeUsername: false,
    }))).toBe("ok");
  });

  it("the trail names the login and the field — never the address or the token", async () => {
    const created = await share();
    const [audit] = (await f.audits("credential.shared")).filter((a) => a.targetId === created.id);
    expect(audit?.targetType).toBe("CredentialShareLink");
    expect(audit?.metadata).toEqual({ credentialId: login, field: "password", includeUsername: true, expiresInHours: 24 });
    expect(JSON.stringify(audit)).not.toContain(RECIPIENT);
    expect(JSON.stringify(audit)).not.toContain(created.token.slice(37));
  });

  it("an EMPLOYEE cannot share (C M A, never the employee template)", async () => {
    expect(
      await outcome(createShareLink(employee(), login, { field: "password", recipientEmail: RECIPIENT, expiresInHours: 1, includeUsername: true })),
    ).toBe("FORBIDDEN");
  });

  it("ALWAYS a fresh factor: one older than a minute is refused even inside the vault's window", async () => {
    const stale: MemberActor = { memberId: f.seats.owner.memberId, mfa: { enrolled: true, verifiedAt: minutesAgo(2) } };
    expect(
      await outcome(createShareLink(withActor(stale), login, { field: "password", recipientEmail: RECIPIENT, expiresInHours: 1, includeUsername: true })),
    ).toBe("MFA_REQUIRED:step_up");
    const impersonated: MemberActor = { ...actorFor(f.seats.owner.memberId), impersonated: true };
    expect(
      await outcome(createShareLink(withActor(impersonated), login, { field: "password", recipientEmail: RECIPIENT, expiresInHours: 1, includeUsername: true })),
    ).toBe("FORBIDDEN");
  });

  it("another tenant's login is NOT_FOUND; a field the login does not carry, a bad address or a lifetime over the cap are refused", async () => {
    const base = { field: "password", recipientEmail: RECIPIENT, expiresInHours: 1, includeUsername: true };
    expect(await outcome(createShareLink(owner(), otherLogin, base))).toBe("NOT_FOUND");
    expect(await outcome(createShareLink(owner(), apiKey, { ...base, field: "apiSecret" }))).toBe("INVALID_INPUT");
    expect(await outcome(createShareLink(owner(), login, { ...base, field: "apiKey" }))).toBe("INVALID_INPUT");
    expect(await outcome(createShareLink(owner(), login, { ...base, recipientEmail: "not an address" }))).toBe("EMAIL_INVALID");
    expect(await outcome(createShareLink(owner(), login, { ...base, expiresInHours: 169 }))).toBe("INVALID_INPUT");
    expect(await outcome(createShareLink(owner(), login, { ...base, expiresInHours: 0 }))).toBe("INVALID_INPUT");
    await updatePreferences(owner(), { vault: { shareLinkMaxTtlHours: 24 } });
    try {
      expect(await outcome(createShareLink(owner(), login, { ...base, expiresInHours: 72 }))).toBe("INVALID_INPUT");
    } finally {
      await updatePreferences(owner(), { vault: { shareLinkMaxTtlHours: 168 } });
    }
  });

  it("a seven-day link — exactly on the database's cap — is accepted", async () => {
    const created = await share({ expiresInHours: 168 });
    const stored = await row(created.id);
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(168 * 3_600_000);
  });

  it("share links OFF: none can be made, and every link made before is stopped FOR GOOD — on again revives none", async () => {
    const live = await share();
    await updatePreferences(owner(), { vault: { allowExternalShareLinks: false } });
    try {
      expect(
        await outcome(createShareLink(owner(), login, { field: "password", recipientEmail: RECIPIENT, expiresInHours: 1, includeUsername: true })),
      ).toBe("SHARE_LINKS_OFF");
      expect(await previewShareLink(live.token)).toBeNull();
      expect(await sendShareCode(live.token, compose)).toEqual({ ok: false, reason: "dead" });
    } finally {
      await updatePreferences(owner(), { vault: { allowExternalShareLinks: true } });
    }
    // The security review's medium: an agency that stops links in an
    // incident and turns them on a day later must not revive the old ones.
    expect(await previewShareLink(live.token)).toBeNull();
    expect((await listShareLinks(owner(), login)).find((l) => l.id === live.id)?.status).toBe("stopped");
    const stamp = await f.platform.tenantPreference.findFirst({
      where: { tenantId: f.tenantId, key: "vault.shareLinksStoppedAt" },
      select: { value: true },
    });
    expect(typeof stamp?.value).toBe("string");
    // A link made after is live.
    expect(await previewShareLink((await share()).token)).not.toBeNull();
  });

  it("turning share links ON asks settings:manage_modules; turning them OFF — the incident's direction — does not", async () => {
    // The admin holds `settings:edit` and not `settings:manage_modules`
    // (AUTHZ §5: turning links ON is the privilege decision).
    expect(await outcome(updatePreferences(admin(), { vault: { allowExternalShareLinks: false } }))).toBe("ok");
    try {
      expect(await outcome(updatePreferences(admin(), { vault: { allowExternalShareLinks: true } }))).toBe("FORBIDDEN");
    } finally {
      await updatePreferences(owner(), { vault: { allowExternalShareLinks: true } });
    }
    expect(await outcome(updatePreferences(admin(), { vault: { shareLinkMaxTtlHours: 168 } }))).toBe("ok");
  });

  it("each link is one of its maker's reveals for the hour: a lowered budget refuses the next, recorded", async () => {
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const used = await f.platform.auditEvent.count({
      where: {
        tenantId: f.tenantId,
        actorType: "MEMBER",
        actorId: f.seats.manager.memberId,
        action: { in: [...REVEAL_ACTIONS] },
        createdAt: { gte: hourAgo },
      },
    });
    await updatePreferences(owner(), { vault: { revealBudgetPerHour: used + 1 } });
    try {
      const base = { field: "password", recipientEmail: RECIPIENT, expiresInHours: 1, includeUsername: true };
      expect(await outcome(createShareLink(manager(), login, base))).toBe("ok");
      expect(await outcome(createShareLink(manager(), login, base))).toBe("REVEAL_BUDGET_EXCEEDED");
      const refused = (await f.audits("vault.reveal_budget_exceeded")).filter((a) => a.actorId === f.seats.manager.memberId);
      expect(refused.at(-1)?.metadata).toEqual({ used: used + 1, budget: used + 1, act: "share" });
    } finally {
      await updatePreferences(owner(), { vault: { revealBudgetPerHour: 100 } });
    }
  });

  it("a member who may share but not REVEAL cannot make a link — a link to oneself would be a reveal", async () => {
    sharerUserId = randomUUID();
    await f.platform.user.create({ data: { id: sharerUserId, name: "sharer", email: `sharer-${RUN}@test.invalid` } });
    const member = await f.platform.member.create({ data: { tenantId: f.tenantId, userId: sharerUserId } });
    const perms = await f.platform.permission.findMany({
      where: { code: { in: ["credential:view", "credential:share", "client:view_all"] } },
      select: { id: true },
    });
    expect(perms).toHaveLength(3);
    const role = await f.platform.role.create({ data: { tenantId: f.tenantId, name: `sharer-${RUN}` } });
    await f.platform.rolePermission.createMany({
      data: perms.map((p) => ({ tenantId: f.tenantId, roleId: role.id, permissionId: p.id })),
    });
    await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: member.id, roleId: role.id } });
    const attempt = () =>
      outcome(
        createShareLink(withActor(actorFor(member.id)), login, { field: "password", recipientEmail: RECIPIENT, expiresInHours: 1, includeUsername: true }),
      );
    expect(await attempt()).toBe("FORBIDDEN");
    // The positive control: the same role WITH `credential:reveal` may — so
    // the refusal above was the reveal code's, and nothing else's.
    const reveal = await f.platform.permission.findUniqueOrThrow({ where: { code: "credential:reveal" }, select: { id: true } });
    await f.platform.rolePermission.create({ data: { tenantId: f.tenantId, roleId: role.id, permissionId: reveal.id } });
    expect(await attempt()).toBe("ok");
  });
});

describe("opening a link — a code to the bound address, once", () => {
  it("the page knows the agency's name before the code, and nothing for a bad token", async () => {
    const { token } = await share();
    expect(await previewShareLink(token)).toEqual({ tenantName: expect.stringContaining("vlink") });
    const parsed = parseShareToken(token)!;
    // The same random part under ANOTHER tenant's id names nothing there.
    expect(await previewShareLink(`${other.tenantId}${token.slice(36)}`)).toBeNull();
    expect(await previewShareLink(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(await previewShareLink("nonsense")).toBeNull();
    expect(parsed.tenantId).toBe(f.tenantId);
  });

  it("the whole life: code mailed to the bound address → wrong code counted → right code shows it once → dead", async () => {
    const { id, token } = await share();
    // No code yet: nothing to check, nothing counted.
    expect(await openShareLink(token, "123456")).toEqual({ ok: false, reason: "no_code" });
    expect((await row(id)).codeAttempts).toBe(0);
    // A malformed code is free.
    expect(await openShareLink(token, "12345")).toEqual({ ok: false, reason: "malformed" });

    expect(await sendShareCode(token, compose)).toEqual({ ok: true });
    const code = lastCodeTo(RECIPIENT);
    expect(mailbox.at(-1)?.subject).toContain("vlink");
    // Asked again at once: told to wait, and no second mail.
    const mails = mailbox.length;
    expect(await sendShareCode(token, compose)).toEqual({ ok: false, reason: "wait" });
    expect(mailbox.length).toBe(mails);

    const wrong = code === "000000" ? "000001" : "000000";
    expect(await openShareLink(token, wrong)).toEqual({ ok: false, reason: "wrong_code", attemptsLeft: 4 });
    const refused = (await f.audits("credential.share_code_refused")).filter((a) => a.targetId === id);
    expect(refused.map((a) => a.metadata)).toEqual([{ credentialId: login, attempt: 1 }]);

    const opened = await openShareLink(token, code.slice(0, 3) + " " + code.slice(3));
    expect(opened).toEqual({
      ok: true,
      secret: {
        tenantName: expect.stringContaining("vlink"),
        name: "Acme hosting",
        url: "https://panel.example.test",
        username: "acme-admin",
        field: "password",
        value: PASSWORD,
      },
    });
    const stored = await row(id);
    expect(stored.viewedAt).not.toBeNull();
    expect(stored.codeHash).toBeNull();
    expect(stored.codeAttempts).toBe(2);
    const viewed = (await f.audits("credential.share_viewed")).filter((a) => a.targetId === id);
    expect(viewed.map((a) => [a.actorType, a.metadata])).toEqual([["SYSTEM", { credentialId: login, field: "password" }]]);
    expect((await f.audits("credential.share_code_sent")).filter((a) => a.targetId === id)).toHaveLength(1);

    // Once. The same right code again, a fresh code, the page: all dead.
    expect(await openShareLink(token, code)).toEqual({ ok: false, reason: "dead" });
    expect(await sendShareCode(token, compose)).toEqual({ ok: false, reason: "dead" });
    expect(await previewShareLink(token)).toBeNull();
  });

  it("the username stays out unless the link was made with it", async () => {
    const { token } = await share({ includeUsername: false });
    await sendShareCode(token, compose);
    const opened = await openShareLink(token, lastCodeTo(RECIPIENT));
    expect(opened.ok && opened.secret.username).toBeNull();
  });

  it("VIEW-ONCE UNDER CONCURRENCY: five opens with the right code at once → exactly one secret", async () => {
    const { id, token } = await share();
    await sendShareCode(token, compose);
    const code = lastCodeTo(RECIPIENT);
    const results = await Promise.all(Array.from({ length: 5 }, () => openShareLink(token, code)));
    const shown = results.filter((r) => r.ok);
    expect(shown).toHaveLength(1);
    // A loser that waited out its lock budget is `busy` — nothing shown
    // either way; view-once is ONE secret and ONE `share_viewed`.
    for (const r of results.filter((x) => !x.ok)) expect(["dead", "busy"]).toContain(!r.ok && r.reason);
    expect((await f.audits("credential.share_viewed")).filter((a) => a.targetId === id)).toHaveLength(1);
  });

  it("THE BRUTE-FORCE BOUND: the fifth wrong code ends the link — the right one is worthless after", async () => {
    const { id, token } = await share();
    await sendShareCode(token, compose);
    const code = lastCodeTo(RECIPIENT);
    const wrongs = ["000000", "111111", "222222", "333333", "444444", "555555"].filter((w) => w !== code).slice(0, 5);
    const answers = [];
    for (const w of wrongs) answers.push(await openShareLink(token, w));
    expect(answers.map((a) => (a.ok ? "ok" : a.reason === "wrong_code" ? `left ${a.attemptsLeft}` : a.reason))).toEqual([
      "left 4",
      "left 3",
      "left 2",
      "left 1",
      "dead",
    ]);
    expect(await openShareLink(token, code)).toEqual({ ok: false, reason: "dead" });
    expect((await row(id)).codeAttempts).toBe(5);
    // The database refuses a sixth whoever asks.
    await expect(
      withTenant(f.tenantId, { type: "system" }, (tx) =>
        tx.$executeRaw`UPDATE credential_share_link SET code_attempts = 6 WHERE id = ${id}`,
      ),
    ).rejects.toThrow(/credential_share_link_code_attempts_range/);
  });

  it("five codes is the most a link is ever mailed", async () => {
    const { id, token } = await share();
    // Four sends spent already (the system principal may move the counter
    // forward), the last one just now and still live:
    await withTenant(f.tenantId, { type: "system" }, (tx) =>
      tx.$executeRaw`UPDATE credential_share_link
        SET codes_sent = 5, code_sent_at = now(), code_hash = ${hashShareCode(id, "999999")},
            code_expires_at = now() + interval '10 minutes'
        WHERE id = ${id}`,
    );
    // Its live code still works for typing — but no sixth goes out.
    expect(await sendShareCode(token, compose)).toEqual({ ok: false, reason: "no_codes" });
    expect(await previewShareLink(token)).not.toBeNull();
    await expect(
      withTenant(f.tenantId, { type: "system" }, (tx) =>
        tx.$executeRaw`UPDATE credential_share_link SET codes_sent = 6 WHERE id = ${id}`,
      ),
    ).rejects.toThrow(/credential_share_link_codes_sent_range/);
  });

  it("an expired code is not checked or counted; a new one is", async () => {
    const { id, token } = await share();
    await sendShareCode(token, compose);
    const code = lastCodeTo(RECIPIENT);
    await withTenant(f.tenantId, { type: "system" }, (tx) =>
      tx.$executeRaw`UPDATE credential_share_link SET code_expires_at = now() - interval '1 second' WHERE id = ${id}`,
    );
    expect(await openShareLink(token, code)).toEqual({ ok: false, reason: "no_code" });
    expect((await row(id)).codeAttempts).toBe(0);
  });

  it("a link whose login's secret changed since — or whose login is gone — opens nothing", async () => {
    const changed = await share();
    await replaceCredentialSecret(owner(), login, { secret: { password: `${PASSWORD}-2` } });
    expect(await previewShareLink(changed.token)).toBeNull();
    expect((await listShareLinks(owner(), login)).find((l) => l.id === changed.id)?.status).toBe("changed");

    const doomed = (
      await createCredential(owner(), { clientId: acme, type: "LOGIN", name: "Doomed", secret: { password: "p" } })
    ).id;
    const gone = await createShareLink(owner(), doomed, { field: "password", recipientEmail: RECIPIENT, expiresInHours: 1, includeUsername: true });
    const goneToken = gone.url.slice(gone.url.indexOf("/portal/share/") + 14);
    await deleteCredential(owner(), doomed);
    expect(await previewShareLink(goneToken)).toBeNull();
  });

  it("one ADDRESS is mailed at most six codes an hour, across every link made for it", async () => {
    const to = `many-${RUN}@example.test`;
    const answers = [];
    for (let i = 0; i < 7; i += 1) answers.push(await sendShareCode((await share({ recipientEmail: to })).token, compose));
    expect(answers.slice(0, 6).every((a) => a.ok)).toBe(true);
    expect(answers[6]).toEqual({ ok: false, reason: "address_busy" });
    expect(mailbox.filter((m) => m.to === to)).toHaveLength(6);
  });

  it("a code mail that fails says so; the code is kept and the send is spent", async () => {
    const { id, token } = await share();
    const working = setTransport(async () => {
      throw new Error("mail is down");
    });
    try {
      expect(await sendShareCode(token, compose)).toEqual({ ok: false, reason: "mail_failed" });
    } finally {
      setTransport(working);
    }
    const stored = await row(id);
    expect(stored.codesSent).toBe(1);
    expect(stored.codeHash).not.toBeNull();
  });

  it("the vault closed by the PLAN kills links too (gates 1–3, read under the system principal)", async () => {
    const { token } = await share();
    const before = await f.platform.tenant.findUniqueOrThrow({ where: { id: f.tenantId }, select: { entitlements: true } });
    const ents = parseEntitlements(before.entitlements);
    await f.platform.tenant.update({
      where: { id: f.tenantId },
      data: { entitlements: { ...ents, modules: { ...ents.modules, vault: false } } },
    });
    try {
      expect(await previewShareLink(token)).toBeNull();
    } finally {
      await f.platform.tenant.update({ where: { id: f.tenantId }, data: { entitlements: before.entitlements ?? {} } });
    }
    expect(await previewShareLink(token)).not.toBeNull();
  });

  it("the vault module switched off by the workspace PAUSES every link — a module or plan change is not an incident response; on again, they live", async () => {
    const { token } = await share();
    await setModuleEnabled(owner(), "vault", false);
    try {
      expect(await previewShareLink(token)).toBeNull();
    } finally {
      await setModuleEnabled(owner(), "vault", true);
    }
    expect(await previewShareLink(token)).not.toBeNull();
  });
});

describe("TTL, held by the database", () => {
  /** A link written by hand under the member principal (the guard allows the member, now-ish). */
  const insertRaw = (args: { createdAgo: string; expiresIn: string; memberId?: string }) => {
    const { tokenHash, token } = mintShareToken(f.tenantId);
    const id = randomUUID();
    const memberId = args.memberId ?? f.seats.owner.memberId;
    const run = withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, async (tx) => {
      const version = await secretVersion(login);
      await tx.$executeRawUnsafe(
        `INSERT INTO credential_share_link
           (id, tenant_id, credential_id, token_hash, field, recipient_email, secret_version, expires_at, created_by_member_id, created_at)
         VALUES ($1, $2, $3, $4, 'password', $5, $6, now() + $7::interval, $8, now() - $9::interval)`,
        id,
        f.tenantId,
        login,
        tokenHash,
        RECIPIENT,
        version,
        args.expiresIn,
        memberId,
        args.createdAgo,
      );
    });
    return { id, token, run };
  };

  it("a live link is listed however many newer links have ended (the list is the only place to revoke it)", async () => {
    const live = await share();
    for (let i = 0; i < 21; i += 1) await insertRaw({ createdAgo: "0 seconds", expiresIn: "1 millisecond" }).run;
    await new Promise((r) => setTimeout(r, 50));
    const listed = await listShareLinks(owner(), login);
    expect(listed.find((l) => l.id === live.id)?.status).toBe("waiting");
    expect(new Set(listed.map((l) => l.id)).size).toBe(listed.length);
  });

  it("an expired link opens nothing", async () => {
    const { token, run } = insertRaw({ createdAgo: "3 minutes", expiresIn: "-1 minute" });
    await run;
    expect(await previewShareLink(token)).toBeNull();
    expect(await sendShareCode(token, compose)).toEqual({ ok: false, reason: "dead" });
  });

  it("refuses a lifetime over 168 hours, a backdated birth, and a link made in another member's name", async () => {
    await expect(insertRaw({ createdAgo: "0 seconds", expiresIn: "169 hours" }).run).rejects.toThrow(/credential_share_link_lifetime/);
    await expect(insertRaw({ createdAgo: "1 day", expiresIn: "1 hour" }).run).rejects.toThrow(/CRED_SHARE_LINK_GUARD/);
    await expect(
      insertRaw({ createdAgo: "0 seconds", expiresIn: "1 hour", memberId: f.seats.manager.memberId }).run,
    ).rejects.toThrow(/CRED_SHARE_LINK_GUARD/);
  });
});

describe("revoke and the list — credential:share ✦", () => {
  it("revokes a waiting link once; then it is closed, dead and listed as revoked", async () => {
    const { id, token } = await share();
    expect(await outcome(revokeShareLink(employee(), id))).toBe("FORBIDDEN");
    await revokeShareLink(manager(), id);
    expect(await outcome(revokeShareLink(owner(), id))).toBe("SHARE_LINK_CLOSED");
    expect(await previewShareLink(token)).toBeNull();
    const audits = (await f.audits("credential.share_revoked")).filter((a) => a.targetId === id);
    expect(audits.map((a) => [a.actorId, a.metadata])).toEqual([[f.seats.manager.memberId, { credentialId: login }]]);
    const listed = (await listShareLinks(owner(), login)).find((l) => l.id === id);
    expect(listed).toMatchObject({ status: "revoked", recipientEmail: RECIPIENT, field: "password" });
    expect(listed?.closedAt).not.toBeNull();
  });

  it("an opened link cannot be revoked", async () => {
    const { id, token } = await share();
    await sendShareCode(token, compose);
    await openShareLink(token, lastCodeTo(RECIPIENT));
    expect(await outcome(revokeShareLink(owner(), id))).toBe("SHARE_LINK_CLOSED");
    expect((await listShareLinks(owner(), login)).find((l) => l.id === id)?.status).toBe("viewed");
  });

  it("an employee may not list a login's links; another tenant's link id is NOT_FOUND", async () => {
    expect(await outcome(listShareLinks(employee(), login))).toBe("FORBIDDEN");
    const theirs = await createShareLink({ tenantId: other.tenantId, actor: actorFor(other.seats.owner.memberId) }, otherLogin, {
      field: "password",
      recipientEmail: RECIPIENT,
      expiresInHours: 1,
      includeUsername: true,
    });
    expect(await outcome(revokeShareLink(owner(), theirs.id))).toBe("NOT_FOUND");
  });
});

describe("the database's own walls", () => {
  it("a contact principal reads zero rows and writes none", async () => {
    await share();
    const contact = { type: "contact", id: randomUUID(), clientId: acme } as const;
    const rows = await withTenant(f.tenantId, contact, (tx) => tx.credentialShareLink.findMany({ select: { id: true } }));
    expect(rows).toEqual([]);
  });

  it("a member cannot do the share page's writes; the system principal cannot revoke; counters never go back", async () => {
    const { id, token } = await share();
    const asMember = (sql: string) =>
      withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, (tx) => tx.$executeRawUnsafe(sql, id));
    await expect(asMember("UPDATE credential_share_link SET viewed_at = now() WHERE id = $1")).rejects.toThrow(/CRED_SHARE_LINK_GUARD|credential_share_link_viewed_with_a_code/);
    await expect(asMember("UPDATE credential_share_link SET code_attempts = 1 WHERE id = $1")).rejects.toThrow(/CRED_SHARE_LINK_GUARD/);
    await expect(
      withTenant(f.tenantId, { type: "system" }, (tx) =>
        tx.$executeRawUnsafe(
          "UPDATE credential_share_link SET revoked_at = now(), revoked_by_member_id = $2 WHERE id = $1",
          id,
          f.seats.owner.memberId,
        ),
      ),
    ).rejects.toThrow(/CRED_SHARE_LINK_GUARD/);
    await sendShareCode(token, compose);
    await expect(
      withTenant(f.tenantId, { type: "system" }, (tx) => tx.$executeRawUnsafe("UPDATE credential_share_link SET codes_sent = 0, code_sent_at = NULL, code_hash = NULL, code_expires_at = NULL WHERE id = $1", id)),
    ).rejects.toThrow(/CRED_SHARE_LINK_GUARD/);
    await expect(
      withTenant(f.tenantId, { type: "system" }, (tx) => tx.$executeRawUnsafe("UPDATE credential_share_link SET expires_at = expires_at + interval '1 hour' WHERE id = $1", id)),
    ).rejects.toThrow(/CRED_SHARE_LINK_GUARD/);
  });

  it("no table and no audit row holds a token's secret half, a code or the plaintext; the address only on the link's own row", async () => {
    const { token } = await share();
    await sendShareCode(token, compose);
    const code = lastCodeTo(RECIPIENT);
    const randomPart = token.slice(37);
    const links = await f.platform.credentialShareLink.findMany({ where: { tenantId: f.tenantId } });
    const audit = await f.platform.auditEvent.findMany({ where: { tenantId: f.tenantId } });
    const dump = JSON.stringify(links);
    expect(dump).not.toContain(randomPart);
    expect(dump).not.toContain(PASSWORD);
    expect(links.every((l) => l.codeHash === null || /^[0-9a-f]{64}$/.test(l.codeHash))).toBe(true);
    const trail = JSON.stringify(audit);
    expect(trail).not.toContain(randomPart);
    expect(trail).not.toContain(RECIPIENT);
    expect(trail).not.toContain(PASSWORD);
    // The code itself appears in no stored metadata (`attempt` is a count,
    // not a code). Ids masked first: six digits can occur inside a uuid.
    for (const a of audit.filter((x) => String(x.action).startsWith("credential.share"))) {
      expect(maskIds(a.metadata)).not.toContain(code);
    }
  });
});
