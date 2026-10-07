import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { resetTenantDekCache } from "@/crypto/tenant-key";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { setTransport, type MailTransport } from "@/mailer";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { setModuleEnabled, updatePreferences } from "@/preferences/service";
import { resetLocalLimiter } from "@/ratelimit";

import {
  createCredential,
  deleteCredential,
  hideLoginFromClient,
  listPortalLogins,
  lookAtPortalLogin,
  openPortalLoginsDoor,
  portalLoginsShown,
  readPortalLoginsDoor,
  resendPortalLoginsCode,
  showLoginToClient,
  startPortalLoginsDoor,
  type LoginsCodeMail,
  type PasswordCheck,
} from "./index";
import { hashShareCode } from "./share-token";

/**
 * THE LOGINS SHOWN TO A CLIENT against the real database and the real
 * app_runtime role (Phase 3V slice 91; founder decisions C52 (d) and (k),
 * C59). The gate test a CLIENT_VISIBLE login needs (PLAN §0's brief): a
 * contact of ANOTHER client gets zero rows; the switch off ⇒ zero rows (and
 * it lives in the DATABASE — `portal_vault_switch`); a helper at the client
 * (`CONTACT_COLLABORATOR`) gets zero rows; a contact still gets zero rows
 * of `credential_secret` for a shown login. Then the member's mark (✦,
 * always a fresh factor, the switch, C49), switching off hiding every login
 * for good (C59 (b)), the client's door (a password, then a mailed code,
 * five checks, bound to the session, open for the staff window, a day's
 * cap), the look (audited to the CONTACT, their own budget), the switch
 * off and the vault module closed refused by the SYSTEM side on its own
 * (the module test runs with the contact's stale open gates, so only the
 * broker's restatement can refuse it), and the door's guard.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let acme: string;
let beta: string;
let shown: string; // Acme, client-level LOGIN — shown to the client
let hidden: string; // Acme, never shown
let betaShown: string; // Beta's, shown to Beta
let own: string; // the agency's own (C49)

const RUN = randomUUID().slice(0, 8);
const PASSWORD = `Portal-pw-${RUN}-zq!`;
const carol = randomUUID(); // Acme, PRIMARY
const dan = randomUUID(); // Acme, COLLABORATOR
const bo = randomUUID(); // Beta, PRIMARY
const eva = randomUUID(); // Acme, PRIMARY — the budgets' own contact
const gil = randomUUID(); // Acme, PRIMARY — the look budget's own contact
const emailOf = (name: string) => `vport-${name}-${RUN}@test.invalid`;

const owner = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) });
const admin = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.admin.memberId) });
const manager = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.manager.memberId) });
const employee = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.employee.memberId) });
const withActor = (actor: MemberActor) => ({ tenantId: f.tenantId, actor });
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

const principal = (contactId: string, clientId = acme): PortalPrincipal => ({
  contactId,
  tenantId: f.tenantId,
  clientId,
  gates,
});
const at = (contactId: string, sessionId: string, clientId = acme) => ({ principal: principal(contactId, clientId), sessionId });

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

const right: PasswordCheck = async () => "ok";
const wrong: PasswordCheck = async () => "wrong";

/** Mail is captured here: the code reaches the test the way it reaches a person. */
const mailbox: { to: string; subject: string; text: string }[] = [];
let previousTransport: MailTransport;
const compose: LoginsCodeMail = ({ code, tenantName, minutes }) => ({
  subject: `Code for your logins from ${tenantName}`,
  text: `code ${code} for ${minutes} minutes`,
});
const lastCodeTo = (to: string): string => {
  const mail = mailbox.filter((m) => m.to === to).at(-1);
  const code = mail?.text.match(/code (\d{6})/)?.[1];
  if (!code) throw new Error(`no code mailed to ${to}`);
  return code;
};

/** The ids a contact's OWN transaction reads of `credential_item`. */
const contactSees = (contactId: string, clientId = acme) =>
  withTenant(f.tenantId, { type: "contact", id: contactId, clientId }, async (tx) =>
    (await tx.credentialItem.findMany({ select: { id: true } })).map((r) => r.id).sort(),
  );

const setSwitch = (on: boolean) => updatePreferences(owner(), { vault: { allowPortalCredentials: on } });
const visibilityOf = async (id: string) =>
  (await f.platform.credentialItem.findUniqueOrThrow({ where: { id }, select: { visibility: true } })).visibility;

/**
 * A fresh MAIN contact at Acme, for one test: the door's budgets are per
 * contact per hour, so tests that open doors must not share one.
 */
const primary = async (): Promise<{ id: string; email: string }> => {
  const id = randomUUID();
  const email = emailOf(`p${id.slice(0, 8)}`);
  await f.platform.contact.create({
    data: {
      id,
      tenantId: f.tenantId,
      clientId: acme,
      name: `Primary ${id.slice(0, 4)}`,
      email,
      portalProfile: "CONTACT_PRIMARY",
      portalStatus: "ACTIVE",
      invitedAt: new Date("2026-09-01T09:00:00Z"),
      emailVerified: true,
    },
  });
  return { id, email };
};

/** Open the door for (contact, session) through both steps; returns when it is open. */
const openDoor = async (contactId: string, sessionId: string) => {
  const started = await startPortalLoginsDoor(at(contactId, sessionId), right, compose);
  expect(started).toEqual({ ok: true });
  const contact = await f.platform.contact.findUniqueOrThrow({ where: { id: contactId }, select: { email: true } });
  const opened = await openPortalLoginsDoor(at(contactId, sessionId), lastCodeTo(contact.email));
  expect(opened.ok).toBe(true);
};

beforeAll(async () => {
  f = await setupTenant("vport");
  acme = randomUUID();
  beta = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme" },
      { id: beta, tenantId: f.tenantId, name: "Beta" },
    ],
  });
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  const contact = (id: string, clientId: string, name: string, profile: "CONTACT_PRIMARY" | "CONTACT_COLLABORATOR") => ({
    id,
    tenantId: f.tenantId,
    clientId,
    name,
    email: emailOf(name.toLowerCase()),
    portalProfile: profile,
    portalStatus: "ACTIVE" as const,
    invitedAt,
    emailVerified: true,
  });
  await f.platform.contact.createMany({
    data: [
      contact(carol, acme, "Carol", "CONTACT_PRIMARY"),
      contact(dan, acme, "Dan", "CONTACT_COLLABORATOR"),
      contact(bo, beta, "Bo", "CONTACT_PRIMARY"),
      contact(eva, acme, "Eva", "CONTACT_PRIMARY"),
      contact(gil, acme, "Gil", "CONTACT_PRIMARY"),
    ],
  });
  gates = await resolvePortalModuleGates(f.tenantId);

  const make = (clientId: string | null, name: string, secret: Record<string, string>, username?: string) =>
    createCredential(owner(), {
      ...(clientId ? { clientId } : {}),
      type: "LOGIN",
      name,
      ...(username ? { username } : {}),
      url: "https://panel.example.test",
      secret,
    });
  shown = (await make(acme, "Acme hosting", { password: PASSWORD }, "acme-admin")).id;
  hidden = (await make(acme, "Acme internal", { password: `hidden-${RUN}` })).id;
  betaShown = (await make(beta, "Beta hosting", { password: `beta-${RUN}` })).id;
  own = (await make(null, "Our registrar", { password: `own-${RUN}` })).id;

  previousTransport = setTransport(async (msg) => {
    mailbox.push({ to: msg.to, subject: msg.subject, text: msg.text });
  });
  await updatePreferences(owner(), { vault: { revealBudgetPerHour: 100 } });
  await setSwitch(true);
  await showLoginToClient(owner(), shown);
  await showLoginToClient(owner(), betaShown);
}, 180_000);

// The per-address code bucket (`vault.share_code_to`) is in-process; each
// test starts with it empty.
beforeEach(() => resetLocalLimiter());

afterAll(async () => {
  if (previousTransport) setTransport(previousTransport);
  if (f) {
    // The door's ALARM (slice 99): the five wrong codes and the day's wrong
    // passwords below raise it, so the owners' inbox rows and both mails
    // exist — and RESTRICT the tenant.
    await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
    // Doors go with their contact (FK cascade).
    await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.credentialItem.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  }
  resetTenantDekCache();
  await f?.cleanup();
}, 180_000);

describe("the gate a CLIENT_VISIBLE login needs — decided by the database", () => {
  it("a main contact reads their own client's shown logins only; another client's contact and a helper read none of them", async () => {
    expect(await contactSees(carol)).toEqual([shown]);
    expect(await contactSees(bo, beta)).toEqual([betaShown]);
    // A helper at the client: the policy's own MAIN-contact term (C59 (a)),
    // not only the application's capability.
    expect(await contactSees(dan)).toEqual([]);
    // A principal claiming a client it does not belong to reads nothing:
    // its contact row is not that client's.
    expect(await contactSees(carol, beta)).toEqual([]);
  });

  it("the switch OFF gives a contact zero rows even of a login still marked — the policy, not the projection", async () => {
    // Off by the preference row ALONE (no sweep), to prove the DATABASE
    // decides: the login stays CLIENT_VISIBLE underneath.
    await f.platform.tenantPreference.update({
      where: { tenantId_key: { tenantId: f.tenantId, key: "vault.allowPortalCredentials" } },
      data: { value: false },
    });
    try {
      expect(await visibilityOf(shown)).toBe("CLIENT_VISIBLE");
      expect(await contactSees(carol)).toEqual([]);
      expect(await contactSees(bo, beta)).toEqual([]);
      expect(await portalLoginsShown(principal(carol))).toBe(false);
      // The function the policy calls answers for the transaction's tenant.
      const on = await withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, async (tx) =>
        (await tx.$queryRaw<{ on: boolean }[]>`SELECT vault_portal_credentials_on() AS on`)[0]?.on,
      );
      expect(on).toBe(false);
    } finally {
      await f.platform.tenantPreference.update({
        where: { tenantId_key: { tenantId: f.tenantId, key: "vault.allowPortalCredentials" } },
        data: { value: true },
      });
    }
    expect(await contactSees(carol)).toEqual([shown]);
  });

  it("a binned or archived login is not read by a contact, even marked", async () => {
    await f.platform.credentialItem.update({ where: { id: shown }, data: { archivedAt: new Date() } });
    expect(await contactSees(carol)).toEqual([]);
    await f.platform.credentialItem.update({ where: { id: shown }, data: { archivedAt: null, deletedAt: new Date() } });
    expect(await contactSees(carol)).toEqual([]);
    await f.platform.credentialItem.update({ where: { id: shown }, data: { deletedAt: null } });
    expect(await contactSees(carol)).toEqual([shown]);
  });

  it("a contact reads zero rows of the secret and its history, for a SHOWN login too", async () => {
    await withTenant(f.tenantId, { type: "contact", id: carol, clientId: acme }, async (tx) => {
      expect(await tx.credentialSecret.findMany({ where: { credentialId: shown }, select: { credentialId: true } })).toEqual([]);
      expect(await tx.credentialVersion.findMany({ where: { credentialId: shown }, select: { id: true } })).toEqual([]);
      expect(await tx.contactVaultUnlock.findMany({ select: { id: true } })).toEqual([]);
    });
  });
});

describe("showing a login — credential:change_visibility ✦, always a fresh factor", () => {
  it("owner and admin may; a manager and an employee may not", async () => {
    await hideLoginFromClient(owner(), shown);
    expect(await visibilityOf(shown)).toBe("INTERNAL");
    expect(await outcome(showLoginToClient(manager(), shown))).toBe("FORBIDDEN");
    expect(await outcome(showLoginToClient(employee(), shown))).toBe("FORBIDDEN");
    expect(await outcome(showLoginToClient(admin(), shown))).toBe("ok");
    expect(await visibilityOf(shown)).toBe("CLIENT_VISIBLE");
    const [audit] = (await f.audits("credential.visibility_changed")).filter(
      (a) => a.targetId === shown && (a.metadata as { visibility?: string }).visibility === "CLIENT_VISIBLE",
    ).slice(-1);
    expect(audit?.metadata).toEqual({ visibility: "CLIENT_VISIBLE", clientId: acme });
  });

  it("a factor older than a minute is refused; the agency's own login has nobody to be shown to", async () => {
    const stale: MemberActor = { memberId: f.seats.owner.memberId, mfa: { enrolled: true, verifiedAt: minutesAgo(2) } };
    expect(await outcome(showLoginToClient(withActor(stale), hidden))).toBe("MFA_REQUIRED:step_up");
    expect(await visibilityOf(hidden)).toBe("INTERNAL");
    expect(await outcome(showLoginToClient(owner(), own))).toBe("LOGIN_HAS_NO_CLIENT");
    // Hiding asks the vault's window only — the stale-for-showing factor is
    // still inside the ten minutes.
    expect(await outcome(hideLoginFromClient(withActor(stale), hidden))).toBe("ok");
  });

  it("showing twice or hiding twice writes one row each way", async () => {
    const before = (await f.audits("credential.visibility_changed")).filter((a) => a.targetId === hidden).length;
    await showLoginToClient(owner(), hidden);
    await showLoginToClient(owner(), hidden);
    await hideLoginFromClient(owner(), hidden);
    await hideLoginFromClient(owner(), hidden);
    const after = (await f.audits("credential.visibility_changed")).filter((a) => a.targetId === hidden).length;
    expect(after - before).toBe(2);
    expect(await visibilityOf(hidden)).toBe("INTERNAL");
  });
});

describe("a binned login is never shown", () => {
  it("deleting a shown login puts it back to INTERNAL", async () => {
    const id = (
      await createCredential(owner(), { clientId: acme, type: "LOGIN", name: "Binned soon", secret: { password: `bin-${RUN}` } })
    ).id;
    await showLoginToClient(owner(), id);
    expect(await visibilityOf(id)).toBe("CLIENT_VISIBLE");
    await deleteCredential(owner(), id);
    expect(await visibilityOf(id)).toBe("INTERNAL");
  });
});

describe("switching client logins off hides every shown login for good (C59 (b))", () => {
  it("off un-marks them all, each with its own row; on again shows nothing until each is shown again", async () => {
    expect(await visibilityOf(shown)).toBe("CLIENT_VISIBLE");
    expect(await visibilityOf(betaShown)).toBe("CLIENT_VISIBLE");
    await setSwitch(false);
    expect(await visibilityOf(shown)).toBe("INTERNAL");
    expect(await visibilityOf(betaShown)).toBe("INTERNAL");
    const swept = (await f.audits("credential.visibility_changed")).filter(
      (a) => (a.metadata as { cause?: string }).cause === "switch_off",
    );
    expect(swept.map((a) => a.targetId).sort()).toEqual([shown, betaShown].sort());
    // While off, nothing can be shown.
    expect(await outcome(showLoginToClient(owner(), shown))).toBe("CLIENT_LOGINS_OFF");
    await setSwitch(true);
    expect(await visibilityOf(shown)).toBe("INTERNAL");
    expect(await contactSees(carol)).toEqual([]);
    await showLoginToClient(owner(), shown);
    await showLoginToClient(owner(), betaShown);
    expect(await contactSees(carol)).toEqual([shown]);
  });

  it("switching it ON asks settings:manage_modules, which an admin (who may edit settings) does not hold", async () => {
    // The admin template holds `settings:edit` (C A), not `settings:manage_modules` (C).
    expect(await outcome(updatePreferences(admin(), { vault: { allowPortalCredentials: true } }))).toBe("FORBIDDEN");
  });
});

describe("the client's door — their password, then a mailed code, each time (C52 (k))", () => {
  it("a wrong password is counted and mails nothing; the right one mails a code bound to the session", async () => {
    const c = await primary();
    const session = randomUUID();
    const mails = mailbox.length;
    expect(await startPortalLoginsDoor(at(c.id, session), wrong, compose)).toEqual({ ok: false, reason: "wrong_password" });
    expect(mailbox.length).toBe(mails);
    const refused = (await f.audits("portal.logins_password_refused")).filter((a) => a.actorId === c.id);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.at(-1)?.actorType).toBe("CONTACT");

    expect(await startPortalLoginsDoor(at(c.id, session), right, compose)).toEqual({ ok: true });
    expect(mailbox.at(-1)?.to).toBe(c.email);
    const door = await f.platform.contactVaultUnlock.findFirstOrThrow({
      where: { tenantId: f.tenantId, contactId: c.id, sessionId: session },
    });
    // The code is kept only as its keyed hash, bound to the door.
    expect(door.codeHash).toBe(hashShareCode(door.id, lastCodeTo(c.email)));
    expect(JSON.stringify(door)).not.toContain(lastCodeTo(c.email));
    expect(door.codesSent).toBe(1);
    // Waiting for that code — so a reload draws the code step, not the password.
    expect(await readPortalLoginsDoor(at(c.id, session))).toEqual({ state: "waiting" });
    expect(await readPortalLoginsDoor(at(c.id, randomUUID()))).toEqual({ state: "closed" });
  });

  it("a wrong code is counted; the right one opens the door for the staff window — in THIS session only", async () => {
    const c = await primary();
    const session = randomUUID();
    await startPortalLoginsDoor(at(c.id, session), right, compose);
    const code = lastCodeTo(c.email);
    const wrongCode = code === "000000" ? "111111" : "000000";
    expect(await openPortalLoginsDoor(at(c.id, session), wrongCode)).toEqual({
      ok: false,
      reason: "wrong_code",
      attemptsLeft: 4,
    });
    expect(await openPortalLoginsDoor(at(c.id, session), "12 34")).toEqual({ ok: false, reason: "malformed" });
    const opened = await openPortalLoginsDoor(at(c.id, session), code);
    expect(opened.ok).toBe(true);
    const minutes = opened.ok ? (opened.openUntil.getTime() - Date.now()) / 60_000 : 0;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);
    const state = await readPortalLoginsDoor(at(c.id, session));
    expect(state.state === "open" ? state.door.openUntil.getTime() : 0).toBe(opened.ok ? opened.openUntil.getTime() : 0);
    // Another session of the same contact — another device — opens nothing.
    expect(await readPortalLoginsDoor(at(c.id, randomUUID()))).toEqual({ state: "closed" });
    // The code is spent: the door holds no code once open.
    expect(await openPortalLoginsDoor(at(c.id, session), code)).toEqual({ ok: false, reason: "start_again" });
  });

  it("five wrong codes spend the door: the password again", async () => {
    const c = await primary();
    const session = randomUUID();
    await startPortalLoginsDoor(at(c.id, session), right, compose);
    const code = lastCodeTo(c.email);
    const wrongCode = code === "000000" ? "111111" : "000000";
    for (let i = 4; i >= 1; i--) {
      expect(await openPortalLoginsDoor(at(c.id, session), wrongCode)).toEqual({ ok: false, reason: "wrong_code", attemptsLeft: i });
    }
    expect(await openPortalLoginsDoor(at(c.id, session), wrongCode)).toEqual({ ok: false, reason: "start_again" });
    // Not even the right code opens a spent door.
    expect(await openPortalLoginsDoor(at(c.id, session), code)).toEqual({ ok: false, reason: "start_again" });
    // Spent: not waiting any more — the page asks the password again.
    expect(await readPortalLoginsDoor(at(c.id, session))).toEqual({ state: "closed" });
  });

  it("two checks of the right code at once open the door once", async () => {
    const c = await primary();
    const session = randomUUID();
    await startPortalLoginsDoor(at(c.id, session), right, compose);
    const code = lastCodeTo(c.email);
    const results = await Promise.all([
      openPortalLoginsDoor(at(c.id, session), code),
      openPortalLoginsDoor(at(c.id, session), code),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await f.audits("portal.logins_opened")).filter((a) => a.actorId === c.id).length).toBeGreaterThan(0);
  });

  it("a new code: half a minute apart, counted, and the old one dies with it", async () => {
    const c = await primary();
    const session = randomUUID();
    await startPortalLoginsDoor(at(c.id, session), right, compose);
    expect(await resendPortalLoginsCode(at(c.id, session), compose)).toEqual({ ok: false, reason: "wait" });
    // No door waiting in a session that never started one.
    expect(await resendPortalLoginsCode(at(c.id, randomUUID()), compose)).toEqual({ ok: false, reason: "start_again" });

    // A door whose code went out four minutes ago (the guard allows a stamp
    // within five), written by the broker's own principal.
    const later = randomUUID();
    const id = randomUUID();
    const sent = minutesAgo(4);
    await withTenant(f.tenantId, { type: "system" }, (tx) =>
      tx.contactVaultUnlock.create({
        data: {
          id,
          tenantId: f.tenantId,
          contactId: c.id,
          sessionId: later,
          codeHash: hashShareCode(id, "424242"),
          codeExpiresAt: new Date(sent.getTime() + 10 * 60_000),
          codeSentAt: sent,
          codesSent: 1,
          createdAt: sent,
        },
        select: { id: true },
      }),
    );
    expect(await resendPortalLoginsCode(at(c.id, later), compose)).toEqual({ ok: true });
    const fresh = lastCodeTo(c.email);
    const row = await f.platform.contactVaultUnlock.findUniqueOrThrow({ where: { id } });
    expect(row.codesSent).toBe(2);
    if (fresh !== "424242") {
      expect(await openPortalLoginsDoor(at(c.id, later), "424242")).toMatchObject({ ok: false, reason: "wrong_code" });
    }
    expect((await openPortalLoginsDoor(at(c.id, later), fresh)).ok).toBe(true);
  });

  it("the hour's password checks are bounded per contact, counted before each check is made", async () => {
    const session = randomUUID();
    for (let i = 0; i < 10; i++) {
      expect(await startPortalLoginsDoor(at(eva, session), wrong, compose)).toEqual({ ok: false, reason: "wrong_password" });
    }
    let checked = false;
    const spy: PasswordCheck = async () => {
      checked = true;
      return "ok";
    };
    expect(await startPortalLoginsDoor(at(eva, session), spy, compose)).toEqual({ ok: false, reason: "limited" });
    // The eleventh never reached the password.
    expect(checked).toBe(false);
  });

  it("the day's password checks are bounded too: the hourly bound alone renews forever", async () => {
    const c = await primary();
    // A day's worth of checks, 23 hours ago — outside the hour, inside the
    // day, and only a window of a whole day reaches them.
    const earlier = new Date(Date.now() - 23 * 60 * 60_000);
    await f.platform.auditEvent.createMany({
      data: Array.from({ length: 20 }, () => ({
        tenantId: f.tenantId,
        action: "portal.logins_unlock_started",
        actorType: "CONTACT" as const,
        actorId: c.id,
        targetType: "Contact",
        targetId: c.id,
        visibility: "TENANT" as const,
        createdAt: earlier,
      })),
    });
    let checked = false;
    const spy: PasswordCheck = async () => {
      checked = true;
      return "ok";
    };
    expect(await startPortalLoginsDoor(at(c.id, randomUUID()), spy, compose)).toEqual({ ok: false, reason: "limited" });
    expect(checked).toBe(false);
  });

  it("a helper at the client gets no door at all", async () => {
    expect(await outcome(startPortalLoginsDoor(at(dan, randomUUID()), right, compose))).toBe("FORBIDDEN");
    expect(await outcome(readPortalLoginsDoor(at(dan, randomUUID())))).toBe("FORBIDDEN");
  });
});

describe("nothing behind the door, nothing at the door — the switch off, the vault module closed", () => {
  const prefRow = { tenantId_key: { tenantId: "", key: "vault.allowPortalCredentials" } };
  /** The switch OFF by its preference row alone (no sweep): the services must refuse on their own. */
  const switchOffBriefly = async (fn: () => Promise<void>) => {
    const where = { tenantId_key: { ...prefRow.tenantId_key, tenantId: f.tenantId } };
    await f.platform.tenantPreference.update({ where, data: { value: false } });
    try {
      await fn();
    } finally {
      await f.platform.tenantPreference.update({ where, data: { value: true } });
    }
  };

  it("with client logins switched off: no door is started, opened or mailed again, and an open one reads closed", async () => {
    const c = await primary();
    const open = randomUUID();
    await openDoor(c.id, open);
    const waiting = randomUUID();
    await startPortalLoginsDoor(at(c.id, waiting), right, compose);
    const code = lastCodeTo(c.email);
    await switchOffBriefly(async () => {
      expect(await startPortalLoginsDoor(at(c.id, randomUUID()), right, compose)).toEqual({ ok: false, reason: "off" });
      expect(await resendPortalLoginsCode(at(c.id, waiting), compose)).toEqual({ ok: false, reason: "off" });
      expect(await openPortalLoginsDoor(at(c.id, waiting), code)).toEqual({ ok: false, reason: "off" });
      expect(await readPortalLoginsDoor(at(c.id, open))).toEqual({ state: "closed" });
      expect(await lookAtPortalLogin(at(c.id, open), shown, "password", "reveal")).toEqual({ ok: false, reason: "not_found" });
    });
    // On again: the open door is open, the waiting code still opens its door.
    expect((await readPortalLoginsDoor(at(c.id, open))).state).toBe("open");
    expect((await openPortalLoginsDoor(at(c.id, waiting), code)).ok).toBe(true);
  });

  it("with the vault module closed, the SYSTEM side refuses on its own — the contact's principal still carries stale open gates", async () => {
    const c = await primary();
    const session = randomUUID();
    await openDoor(c.id, session);
    // `principal()` carries the gates resolved in beforeAll (open), so the
    // contact's own `authorizePortal` passes: what refuses below is the
    // broker's restatement under the system principal.
    await setModuleEnabled(owner(), "vault", false);
    try {
      expect(await readPortalLoginsDoor(at(c.id, session))).toEqual({ state: "closed" });
      expect(await lookAtPortalLogin(at(c.id, session), shown, "password", "reveal")).toEqual({ ok: false, reason: "not_found" });
      expect(await startPortalLoginsDoor(at(c.id, randomUUID()), right, compose)).toEqual({ ok: false, reason: "off" });
    } finally {
      await setModuleEnabled(owner(), "vault", true);
    }
    expect(await lookAtPortalLogin(at(c.id, session), shown, "password", "reveal")).toEqual({ ok: true, value: PASSWORD });
  });
});

describe("a look — one field, audited to the CONTACT, behind the open door", () => {
  it("a closed door is refused; an open one shows the field and records it to the contact", async () => {
    const c = await primary();
    const session = randomUUID();
    expect(await lookAtPortalLogin(at(c.id, session), shown, "password", "reveal")).toEqual({ ok: false, reason: "locked" });
    await openDoor(c.id, session);
    expect(await lookAtPortalLogin(at(c.id, session), shown, "password", "reveal")).toEqual({ ok: true, value: PASSWORD });
    expect(await lookAtPortalLogin(at(c.id, session), shown, "password", "copy")).toEqual({ ok: true, value: PASSWORD });
    const looks = (await f.audits("credential.revealed")).filter((a) => a.actorId === c.id);
    expect(looks.at(-1)).toMatchObject({ actorType: "CONTACT", targetId: shown, metadata: { field: "password" } });
    expect((await f.audits("credential.copied")).filter((a) => a.actorId === c.id).at(-1)?.actorType).toBe("CONTACT");
    // Nothing in the trail carries the value.
    expect(JSON.stringify(await f.audits("credential.revealed"))).not.toContain(PASSWORD);
    // The list behind the door: names and field names, never a value.
    const state = await readPortalLoginsDoor(at(c.id, session));
    if (state.state !== "open") throw new Error("the door should be open");
    const list = await listPortalLogins(principal(c.id), state.door);
    expect(list).toEqual([
      { id: shown, name: "Acme hosting", username: "acme-admin", url: "https://panel.example.test", fields: ["password"] },
    ]);
    expect(JSON.stringify(list)).not.toContain(PASSWORD);
  });

  it("anything not shown to THIS contact is not found — another client's, a hidden one, the agency's own, a field it lacks", async () => {
    const c = await primary();
    const session = randomUUID();
    await openDoor(c.id, session);
    expect(await lookAtPortalLogin(at(c.id, session), betaShown, "password", "reveal")).toEqual({ ok: false, reason: "not_found" });
    expect(await lookAtPortalLogin(at(c.id, session), hidden, "password", "reveal")).toEqual({ ok: false, reason: "not_found" });
    expect(await lookAtPortalLogin(at(c.id, session), own, "password", "reveal")).toEqual({ ok: false, reason: "not_found" });
    expect(await lookAtPortalLogin(at(c.id, session), shown, "apiKey", "reveal")).toEqual({ ok: false, reason: "invalid" });
    expect(await lookAtPortalLogin(at(c.id, session), "", "password", "reveal")).toEqual({ ok: false, reason: "invalid" });
    // Hidden after the door opened: gone at once.
    await hideLoginFromClient(owner(), shown);
    expect(await lookAtPortalLogin(at(c.id, session), shown, "password", "reveal")).toEqual({ ok: false, reason: "not_found" });
    await showLoginToClient(owner(), shown);
  });

  it("another session's open door opens nothing here", async () => {
    const c = await primary();
    const mine = randomUUID();
    await openDoor(c.id, mine);
    expect(await lookAtPortalLogin(at(c.id, randomUUID()), shown, "password", "reveal")).toEqual({ ok: false, reason: "locked" });
  });

  it("the contact's own hourly budget: the refusal is recorded, to the contact", async () => {
    await updatePreferences(owner(), { vault: { revealBudgetPerHour: 2 } });
    try {
      const session = randomUUID();
      await openDoor(gil, session);
      expect((await lookAtPortalLogin(at(gil, session), shown, "password", "reveal")).ok).toBe(true);
      expect((await lookAtPortalLogin(at(gil, session), shown, "password", "copy")).ok).toBe(true);
      expect(await lookAtPortalLogin(at(gil, session), shown, "password", "reveal")).toEqual({ ok: false, reason: "budget" });
      const refused = (await f.audits("vault.reveal_budget_exceeded")).filter((a) => a.actorId === gil);
      expect(refused.at(-1)).toMatchObject({ actorType: "CONTACT", metadata: { used: 2, budget: 2 } });
    } finally {
      await updatePreferences(owner(), { vault: { revealBudgetPerHour: 100 } });
    }
  });
});

describe("the door's guard — only the broker writes it, and only forward", () => {
  const doorOf = async () => {
    const { id: contactId } = await primary();
    const session = randomUUID();
    expect(await startPortalLoginsDoor(at(contactId, session), right, compose)).toEqual({ ok: true });
    return f.platform.contactVaultUnlock.findFirstOrThrow({ where: { tenantId: f.tenantId, contactId, sessionId: session } });
  };
  const system = (fn: (tx: TenantDb) => Promise<unknown>) => withTenant(f.tenantId, { type: "system" }, fn);

  it("a member cannot write a door", async () => {
    const door = await doorOf();
    await expect(
      withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, (tx) =>
        tx.contactVaultUnlock.update({ where: { id: door.id }, data: { codeAttempts: 0 }, select: { id: true } }),
      ),
    ).rejects.toThrow(/CONTACT_VAULT_UNLOCK_GUARD/);
  });

  it("even as SYSTEM: no opening without a counted check of a live code, no window past fifteen minutes, no reopening", async () => {
    const door = await doorOf();
    // An opening that does not count its check.
    await expect(
      system((tx) =>
        tx.contactVaultUnlock.update({
          where: { id: door.id },
          data: { openedAt: new Date(), openUntil: new Date(Date.now() + 5 * 60_000), codeHash: null, codeExpiresAt: null },
          select: { id: true },
        }),
      ),
    ).rejects.toThrow(/CONTACT_VAULT_UNLOCK_GUARD/);
    // A window past fifteen minutes from the statement.
    await expect(
      system((tx) =>
        tx.contactVaultUnlock.update({
          where: { id: door.id },
          data: {
            codeAttempts: 1,
            openedAt: new Date(Date.now() + 4 * 60_000),
            openUntil: new Date(Date.now() + 19 * 60_000),
            codeHash: null,
            codeExpiresAt: null,
          },
          select: { id: true },
        }),
      ),
    ).rejects.toThrow(/CONTACT_VAULT_UNLOCK_GUARD/);
    // A new expiry without a counted send.
    await expect(
      system((tx) =>
        tx.contactVaultUnlock.update({
          where: { id: door.id },
          data: { codeExpiresAt: new Date(Date.now() + 9 * 60_000) },
          select: { id: true },
        }),
      ),
    ).rejects.toThrow(/CONTACT_VAULT_UNLOCK_GUARD/);
    // Counters never go back.
    await system((tx) =>
      tx.contactVaultUnlock.update({ where: { id: door.id }, data: { codeAttempts: 1 }, select: { id: true } }),
    );
    await expect(
      system((tx) => tx.contactVaultUnlock.update({ where: { id: door.id }, data: { codeAttempts: 0 }, select: { id: true } })),
    ).rejects.toThrow(/CONTACT_VAULT_UNLOCK_GUARD/);
  });
});
