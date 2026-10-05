import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { resetTenantDekCache } from "@/crypto/tenant-key";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { setTransport, type MailTransport } from "@/mailer";
import { actorFor, noMfa, setupTenant } from "@/members/dbtest-fixture";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { setModuleEnabled, updatePreferences } from "@/preferences/service";
import { resetLocalLimiter } from "@/ratelimit";

import {
  approveSealedAsk,
  askToOpenSealedLogins,
  confirmSealedAsk,
  createCredential,
  denySealedAsk,
  getSealedAsk,
  listLiveSealedAsks,
  listSealedPortalLogins,
  lookAtSealedLogin,
  openPortalLoginsDoor,
  portalHasSealedLogins,
  readPortalLoginsDoor,
  readSealedPortalState,
  sealLogin,
  sendSealedAskMail,
  startPortalLoginsDoor,
  withdrawSealedAsk,
  type LoginsCodeMail,
  type OpenPortalDoor,
  type PasswordCheck,
} from "./index";

/**
 * A CLIENT ASKS TO OPEN THEIR SEALED LOGINS, against the real database and
 * the real app_runtime role (Phase 3V slice 93; founder decisions C52
 * (f)–(j), C61). What a client sees before asking (a count, C61 (a)), with
 * the client-logins switch OFF throughout (C61 (d)); the ask (password and
 * reason, counted, mailed to every answerer at once); one live ask per
 * client and the 30-day cool-down after a denial, held by the service AND
 * the guard; who may read and answer (`credential:unseal`, C61 (f)) —
 * approve with a fresh code, deny with none (C61 (b)); an approval opening
 * the layer at once, behind the client's door, every look audited to the
 * contact; withdrawal; a confirmation before the wait refused by both; the
 * wait frozen and the agency's own; the module closed restated by the
 * SYSTEM side; the job sending nothing twice.
 *
 * WHAT THIS FILE CANNOT REACH: the silent path's positive half — a
 * confirmation after the wait, the opening 48 hours later, the lapse —
 * needs an ask whose stamps lie days in the past, which the guard allows
 * no writer to make (a stamp is never more than five minutes old). Those
 * transitions are the pure machine's, pinned in `ask-and-wait.test.ts`,
 * and the guard's refusals of each early act are pinned here.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;

const RUN = randomUUID().slice(0, 8);
const emailOf = (name: string) => `vsask-${name}-${RUN}@test.invalid`;

const owner = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) });
const admin = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.admin.memberId) });
const manager = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.manager.memberId) });
const employee = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.employee.memberId) });
const withActor = (actor: MemberActor) => ({ tenantId: f.tenantId, actor });

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

/** The guard's refusal, as the raw error a writer that skipped the services would get. */
const guardRefuses = async (p: Promise<unknown>): Promise<boolean> => {
  try {
    await p;
    return false;
  } catch (e) {
    return String(e instanceof Error ? e.message : e).includes("SEALED_OPEN_REQUEST_GUARD");
  }
};

/** The guard's refusal with ITS OWN words — so a test pins one rule, not whichever refuses first. */
const guardSays = async (p: Promise<unknown>, words: string): Promise<boolean> => {
  try {
    await p;
    return false;
  } catch (e) {
    const message = String(e instanceof Error ? e.message : e);
    return message.includes("SEALED_OPEN_REQUEST_GUARD") && message.includes(words);
  }
};

const right: PasswordCheck = async () => "ok";
const wrong: PasswordCheck = async () => "wrong";

const mailbox: { to: string; text: string }[] = [];
let previousTransport: MailTransport;
const compose: LoginsCodeMail = ({ code }) => ({ subject: "Your code", text: `code ${code}` });
const lastCodeTo = (to: string): string => {
  const mail = mailbox.filter((m) => m.to === to).at(-1);
  const code = mail?.text.match(/code ([0-9]{6})/)?.[1];
  if (!code) throw new Error(`no code mailed to ${to}`);
  return code;
};

type Scene = {
  clientId: string;
  sealed: string;
  plain: string;
  carol: { id: string; email: string };
  dan: { id: string; email: string };
  principal: (contactId: string) => PortalPrincipal;
  at: (contactId: string, sessionId?: string) => { principal: PortalPrincipal; sessionId: string };
};

/**
 * A client of its own for one test — asks are one per client, and a denial
 * cools a client for 30 days — with a main contact (Carol), a helper (Dan),
 * one SEALED login and one plain one.
 */
const scene = async (label: string): Promise<Scene> => {
  const clientId = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: `Client ${label}` } });
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  const person = async (name: string, profile: "CONTACT_PRIMARY" | "CONTACT_COLLABORATOR") => {
    const id = randomUUID();
    const email = emailOf(`${label}-${name}`);
    await f.platform.contact.create({
      data: {
        id,
        tenantId: f.tenantId,
        clientId,
        name: `${name} ${label}`,
        email,
        portalProfile: profile,
        portalStatus: "ACTIVE",
        invitedAt,
        emailVerified: true,
      },
    });
    return { id, email };
  };
  const carol = await person("carol", "CONTACT_PRIMARY");
  const dan = await person("dan", "CONTACT_COLLABORATOR");
  const make = (name: string, password: string) =>
    createCredential(owner(), { clientId, type: "LOGIN", name, username: `${label}-admin`, url: "https://panel.example.test", secret: { password } });
  const sealed = (await make(`Sealed ${label}`, `sealed-${label}-${RUN}`)).id;
  const plain = (await make(`Plain ${label}`, `plain-${label}-${RUN}`)).id;
  await sealLogin(owner(), sealed);
  const principal = (contactId: string): PortalPrincipal => ({ contactId, tenantId: f.tenantId, clientId, gates });
  return {
    clientId,
    sealed,
    plain,
    carol,
    dan,
    principal,
    at: (contactId, sessionId = randomUUID()) => ({ principal: principal(contactId), sessionId }),
  };
};

/** The database's clock a second ago — a raw stamp the guard judges by its own clock, never the test machine's. */
const dbNow = async (): Promise<Date> => {
  const rows = await f.platform.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() - interval '1 second' AS now`;
  return rows[0]!.now;
};

const REASON = "Our developer left and we need the hosting login.";

/** An ask written straight into the table as SYSTEM — the writer the guard must refuse wherever the service would. */
const rawAsk = async (s: Scene, waitDays = 7) => {
  const stamp = await dbNow();
  return withTenant(f.tenantId, { type: "system" }, (tx) =>
    tx.sealedOpenRequest.create({
      data: { tenantId: f.tenantId, clientId: s.clientId, askedByContactId: s.carol.id, reason: REASON, waitDays, askedAt: stamp, createdAt: stamp },
      select: { id: true },
    }),
  );
};

/** Ask as Carol; returns the ask's id. */
const ask = async (s: Scene, reason = REASON): Promise<string> => {
  expect(await askToOpenSealedLogins(s.at(s.carol.id), right, reason)).toEqual({ ok: true });
  const row = await f.platform.sealedOpenRequest.findFirstOrThrow({
    where: { tenantId: f.tenantId, clientId: s.clientId },
    orderBy: { askedAt: "desc" },
    select: { id: true },
  });
  return row.id;
};

/** Open Carol's door in this session through both steps (the client's password, then the mailed code). */
const openDoor = async (s: Scene, sessionId: string): Promise<OpenPortalDoor> => {
  expect(await startPortalLoginsDoor(s.at(s.carol.id, sessionId), right, compose)).toEqual({ ok: true });
  const opened = await openPortalLoginsDoor(s.at(s.carol.id, sessionId), lastCodeTo(s.carol.email));
  expect(opened.ok).toBe(true);
  const state = await readPortalLoginsDoor(s.at(s.carol.id, sessionId));
  if (state.state !== "open") throw new Error("the door did not open");
  return state.door;
};

const outbox = (kind: string, requestId: string) =>
  f.platform.emailOutbox.findMany({
    where: { tenantId: f.tenantId, kind, params: { path: ["requestId"], equals: requestId } },
    select: { receiverType: true, receiverId: true },
  });

beforeAll(async () => {
  f = await setupTenant("vsask");
  gates = await resolvePortalModuleGates(f.tenantId);
  previousTransport = setTransport(async (msg) => {
    mailbox.push({ to: msg.to, text: msg.text });
  });
  // C61 (d): the sealed layer does not hang on "show logins to clients",
  // which stays OFF (its default) for this whole file.
  await updatePreferences(owner(), { vault: { revealBudgetPerHour: 100 } });
}, 180_000);

beforeEach(() => resetLocalLimiter());

afterAll(async () => {
  if (previousTransport) setTransport(previousTransport);
  if (f) {
    await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
    // Asks go with their client (FK cascade), doors with their contact.
    await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.credentialItem.updateMany({ where: { tenantId: f.tenantId }, data: { sealedAt: null } });
    await f.platform.credentialItem.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  }
  resetTenantDekCache();
  await f?.cleanup();
}, 180_000);

describe("before asking — a count, for main contacts, with client logins switched off (C61 (a), (d), (e))", () => {
  it("a main contact sees how many are sealed and may ask; a helper sees nothing; another client's sealed logins are not counted", async () => {
    const s = await scene("count");
    const other = await scene("count-other");
    expect((await f.platform.tenantPreference.findFirst({ where: { tenantId: f.tenantId, key: "vault.allowPortalCredentials" } }))?.value ?? false).toBe(false);
    const state = await readSealedPortalState(s.at(s.carol.id));
    expect(state).toMatchObject({ count: 1, ask: null, canAsk: true, askAgainAt: null, waitDays: 7 });
    expect(await portalHasSealedLogins(s.principal(s.carol.id))).toBe(true);
    // A helper (C61 (e)): no capability — the read refuses, the nav's bit is quietly false, an ask is refused.
    expect(await outcome(readSealedPortalState(s.at(s.dan.id)))).toBe("FORBIDDEN");
    expect(await portalHasSealedLogins(s.principal(s.dan.id))).toBe(false);
    expect(await outcome(askToOpenSealedLogins(s.at(s.dan.id), right, REASON))).toBe("FORBIDDEN");
    // Each client counts its own.
    expect((await readSealedPortalState(other.at(other.carol.id)))?.count).toBe(1);
  });
});

describe("asking (C52 (f))", () => {
  it("a wrong password is counted and makes nothing; a right one makes the ask, mails every answerer at once and is audited to the contact", async () => {
    const s = await scene("ask");
    expect(await askToOpenSealedLogins(s.at(s.carol.id), wrong, REASON)).toEqual({ ok: false, reason: "wrong_password" });
    expect(await f.platform.sealedOpenRequest.count({ where: { tenantId: f.tenantId, clientId: s.clientId } })).toBe(0);
    const refused = await f.audits("portal.logins_password_refused");
    expect(refused.some((a) => a.actorId === s.carol.id && (a.metadata as { purpose?: string }).purpose === "ask")).toBe(true);

    // Free refusals spend nothing: no reason, a reason too long.
    expect(await askToOpenSealedLogins(s.at(s.carol.id), right, "   ")).toEqual({ ok: false, reason: "invalid" });
    expect(await askToOpenSealedLogins(s.at(s.carol.id), right, "x".repeat(1001))).toEqual({ ok: false, reason: "invalid" });

    const id = await ask(s);
    const row = await f.platform.sealedOpenRequest.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ askedByContactId: s.carol.id, reason: REASON, waitDays: 7, remindersSent: 1, approvedAt: null, opensAt: null });
    // Every answerer (C61 (f): the holders of credential:unseal — the
    // owner by default, not the admin), mailed at once: day 0.
    expect(await outbox("vault.sealed_open_asked", id)).toEqual([{ receiverType: "MEMBER", receiverId: f.seats.owner.memberId }]);
    const audit = (await f.audits("credential.open_requested")).find((a) => a.targetId === id);
    expect(audit).toMatchObject({ actorType: "CONTACT", actorId: s.carol.id, targetType: "SealedOpenRequest" });
    // Never the reason's words in the trail.
    expect(JSON.stringify(audit?.metadata)).not.toContain("developer");

    const state = await readSealedPortalState(s.at(s.carol.id));
    expect(state?.ask).toMatchObject({ id, yours: true, reason: REASON });
    expect(state?.ask?.state.kind).toBe("waiting");
    expect(state?.canAsk).toBe(false);
  });

  it("one live ask per client — the service says so, and the database refuses a second all the same", async () => {
    const s = await scene("one");
    await ask(s);
    expect(await askToOpenSealedLogins(s.at(s.carol.id), right, REASON)).toEqual({ ok: false, reason: "already" });
    // Refused after a RIGHT password: recorded with its reason code, never left as a check that went nowhere.
    const refused = (await f.audits("credential.open_request_refused")).filter((a) => a.actorId === s.carol.id);
    expect(refused.map((a) => a.metadata)).toEqual([{ clientId: s.clientId, reason: "already" }]);
    const raw = rawAsk(s);
    expect(await guardRefuses(raw)).toBe(true);
  });

  it("nothing sealed, nothing to ask for — by the service and by the database", async () => {
    const s = await scene("nothing");
    await f.platform.credentialItem.update({ where: { id: s.sealed }, data: { sealedAt: null } });
    expect((await readSealedPortalState(s.at(s.carol.id)))?.canAsk).toBe(false);
    expect(await askToOpenSealedLogins(s.at(s.carol.id), right, REASON)).toEqual({ ok: false, reason: "nothing" });
    const raw = rawAsk(s);
    expect(await guardRefuses(raw)).toBe(true);
  });

  it("the wait is the agency's, frozen on the ask — and the database will not take another (C52 (g))", async () => {
    const s = await scene("wait");
    await updatePreferences(owner(), { vault: { sealedWaitDays: 21 } });
    try {
      const id = await ask(s);
      expect((await f.platform.sealedOpenRequest.findUniqueOrThrow({ where: { id } })).waitDays).toBe(21);
      // A writer that would shorten it (7 while the agency says 21) is refused by the guard.
      const other = await scene("wait-raw");
      const raw = rawAsk(other);
      expect(await guardRefuses(raw)).toBe(true);
      // …and the same ask with the agency's own 21 is taken: it was the wait,
      // nothing else. (Withdrawn at once: written raw, it carries no day-0
      // mail, which the job would rightly send.)
      const made = await rawAsk(other, 21);
      expect(await withdrawSealedAsk(other.at(other.carol.id), made.id)).toEqual({ ok: true });
      // Changing the setting moves no ask already waiting.
      await updatePreferences(owner(), { vault: { sealedWaitDays: 30 } });
      expect((await f.platform.sealedOpenRequest.findUniqueOrThrow({ where: { id } })).waitDays).toBe(21);
    } finally {
      await updatePreferences(owner(), { vault: { sealedWaitDays: 7 } });
    }
  });

  it("at most three asks a day per client — an ask and a withdrawal must not become a mail cannon", async () => {
    const s = await scene("cannon");
    for (let i = 0; i < 3; i++) {
      const id = await ask(s);
      expect(await withdrawSealedAsk(s.at(s.carol.id), id)).toEqual({ ok: true });
    }
    expect(await askToOpenSealedLogins(s.at(s.carol.id), right, REASON)).toEqual({ ok: false, reason: "limited" });
    // …and the page offers no form to spend a password check on.
    expect(await readSealedPortalState(s.at(s.carol.id))).toMatchObject({ canAsk: false, limitedToday: true });
  });
});

describe("who may read and answer (C61 (b), (f))", () => {
  it("the owner (credential:unseal) reads the ask; an admin, a manager and an employee get nothing, and the banner is theirs only", async () => {
    const s = await scene("read");
    const id = await ask(s);
    const view = await getSealedAsk(owner(), id);
    expect(view).toMatchObject({
      client: { id: s.clientId },
      askedBy: { email: s.carol.email },
      reason: REASON,
      sealedCount: 1,
      waitDays: 7,
      can: { approve: true, deny: true },
    });
    expect(view.state.kind).toBe("waiting");
    // Reading needs no fresh factor (the factor is set aside to read and to deny).
    expect((await getSealedAsk(withActor(noMfa(f.seats.owner.memberId)), id)).id).toBe(id);
    for (const who of [admin(), manager(), employee()]) expect(await outcome(getSealedAsk(who, id))).toBe("FORBIDDEN");
    expect((await listLiveSealedAsks(owner())).some((a) => a.id === id)).toBe(true);
    expect(await listLiveSealedAsks(manager())).toEqual([]);
    // Never under impersonation.
    expect(await outcome(getSealedAsk(withActor({ ...actorFor(f.seats.owner.memberId), impersonated: true }), id))).toBe("FORBIDDEN");
  });

  it("a denial asks no code; the client sees it and its reason; a new ask waits 30 days — by the service and the database", async () => {
    const s = await scene("deny");
    const id = await ask(s);
    // Only a holder of credential:unseal denies.
    expect(await outcome(denySealedAsk(manager(), id, "no"))).toBe("FORBIDDEN");
    // C61 (b): no factor at all, and still a denial.
    await denySealedAsk(withActor(noMfa(f.seats.owner.memberId)), id, "  Ask your account manager first.  ");
    const row = await f.platform.sealedOpenRequest.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ deniedByMemberId: f.seats.owner.memberId, denyReason: "Ask your account manager first.", opensAt: null });
    // Idempotent; and no approval after it.
    await denySealedAsk(owner(), id, "again");
    expect(await outcome(approveSealedAsk(owner(), id))).toBe("SEALED_REQUEST_SETTLED");

    const state = await readSealedPortalState(s.at(s.carol.id));
    expect(state?.ask?.state.kind).toBe("denied");
    expect(state?.ask?.denyReason).toBe("Ask your account manager first.");
    expect(state?.canAsk).toBe(false);
    expect(state?.askAgainAt?.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(await askToOpenSealedLogins(s.at(s.carol.id), right, REASON)).toEqual({ ok: false, reason: "cooling" });
    // The client's main contacts are told — Carol, not the helper.
    expect(await outbox("portal.sealed_open_news", id)).toEqual([{ receiverType: "CONTACT", receiverId: s.carol.id }]);
    const audit = (await f.audits("credential.open_request_denied")).find((a) => a.targetId === id);
    expect(audit?.metadata).toEqual({ clientId: s.clientId, afterConfirmation: false, withReason: true });
    // The database holds the cool-down on its own.
    const raw = rawAsk(s);
    expect(await guardRefuses(raw)).toBe(true);
  });

  it("the database's own belt: a member answers only as themselves, only holding credential:unseal, and only approves or denies", async () => {
    const s = await scene("belt");
    const id = await ask(s);
    const asMember = (memberId: string, data: Record<string, unknown>) =>
      withTenant(f.tenantId, { type: "member", id: memberId }, (tx) =>
        tx.sealedOpenRequest.update({ where: { id }, data, select: { id: true } }),
      );
    const now = await dbNow();
    const openFor = { opensAt: now, openUntil: new Date(now.getTime() + 168 * 3_600_000), openedNoticeAt: now };
    // A manager does not hold the code.
    expect(await guardRefuses(asMember(f.seats.manager.memberId, { approvedAt: now, approvedByMemberId: f.seats.manager.memberId, ...openFor }))).toBe(true);
    // The owner, in someone else's name.
    expect(await guardRefuses(asMember(f.seats.owner.memberId, { approvedAt: now, approvedByMemberId: f.seats.admin.memberId, ...openFor }))).toBe(true);
    // The owner, confirming for the client.
    expect(await guardRefuses(asMember(f.seats.owner.memberId, { confirmedAt: now, confirmedByContactId: s.carol.id }))).toBe(true);
    // SYSTEM never answers.
    expect(
      await guardRefuses(
        withTenant(f.tenantId, { type: "system" }, (tx) =>
          tx.sealedOpenRequest.update({ where: { id }, data: { deniedAt: now, deniedByMemberId: f.seats.owner.memberId }, select: { id: true } }),
        ),
      ),
    ).toBe(true);
    // A platform connection, its principal unset, writes nothing.
    expect(await guardRefuses(f.platform.sealedOpenRequest.update({ where: { id }, data: { remindersSent: 9 } }))).toBe(true);
    // What was asked never changes.
    expect(
      await guardRefuses(
        withTenant(f.tenantId, { type: "system" }, (tx) =>
          tx.sealedOpenRequest.update({ where: { id }, data: { reason: "something else" }, select: { id: true } }),
        ),
      ),
    ).toBe(true);
    // A contact principal reads none of it (class A).
    const seen = await withTenant(f.tenantId, { type: "contact", id: s.carol.id, clientId: s.clientId }, (tx) =>
      tx.sealedOpenRequest.count(),
    );
    expect(seen).toBe(0);
  });
});

describe("an approval opens it at once (C52 (f), (h))", () => {
  it("asks a fresh code; then the main contacts open it behind their door — the switch still off — every look audited to them", async () => {
    const s = await scene("open");
    const id = await ask(s);
    // A factor older than a minute is not enough (CP4: always step up).
    const stale = { ...actorFor(f.seats.owner.memberId), mfa: { enrolled: true, verifiedAt: new Date(Date.now() - 5 * 60_000) } };
    expect(await outcome(approveSealedAsk(withActor(stale), id))).toBe("MFA_REQUIRED:step_up");
    expect(await outcome(approveSealedAsk(manager(), id))).toBe("FORBIDDEN");
    await approveSealedAsk(owner(), id);
    const row = await f.platform.sealedOpenRequest.findUniqueOrThrow({ where: { id } });
    expect(row.approvedByMemberId).toBe(f.seats.owner.memberId);
    expect(row.openUntil!.getTime() - row.opensAt!.getTime()).toBe(168 * 3_600_000);
    expect(row.openedNoticeAt?.getTime()).toBe(row.approvedAt?.getTime());
    // Idempotent; and no denial after it opened (C61 (c): until the moment it opens).
    await approveSealedAsk(owner(), id);
    expect(await outcome(denySealedAsk(owner(), id, null))).toBe("SEALED_REQUEST_SETTLED");
    // Everyone told: the answerers it opened (change those passwords), the client's main contacts.
    expect(await outbox("vault.sealed_opened", id)).toEqual([{ receiverType: "MEMBER", receiverId: f.seats.owner.memberId }]);
    expect(await outbox("portal.sealed_open_news", id)).toEqual([{ receiverType: "CONTACT", receiverId: s.carol.id }]);

    const session = randomUUID();
    // Behind the door — which has a purpose now, the switch notwithstanding.
    const door = await openDoor(s, session);
    const listed = await listSealedPortalLogins(s.at(s.carol.id, session), door);
    expect(listed?.logins.map((l) => l.id)).toEqual([s.sealed]);
    const look = await lookAtSealedLogin(s.at(s.carol.id, session), s.sealed, "password", "reveal");
    expect(look).toEqual({ ok: true, value: `sealed-open-${RUN}` });
    const revealed = (await f.audits("credential.revealed")).find((a) => a.targetId === s.sealed && a.actorId === s.carol.id);
    expect(revealed).toMatchObject({ actorType: "CONTACT", metadata: { field: "password", sealed: true, requestId: id } });
    // Not the plain login (it is not sealed), not from another session, not for a helper.
    expect(await lookAtSealedLogin(s.at(s.carol.id, session), s.plain, "password", "reveal")).toEqual({ ok: false, reason: "not_found" });
    expect(await lookAtSealedLogin(s.at(s.carol.id, randomUUID()), s.sealed, "password", "reveal")).toEqual({ ok: false, reason: "locked" });
    expect(await outcome(lookAtSealedLogin(s.at(s.dan.id, session), s.sealed, "password", "reveal"))).toBe("FORBIDDEN");
    // A login SEALED WHILE IT IS OPEN stays shut (both reviews' medium):
    // the approval covered what was sealed when it was given; sealing only
    // ever locks more.
    await sealLogin(owner(), s.plain);
    const after = await listSealedPortalLogins(s.at(s.carol.id, session), door);
    expect(after?.logins.map((l) => l.id)).toEqual([s.sealed]);
    expect(await lookAtSealedLogin(s.at(s.carol.id, session), s.plain, "password", "reveal")).toEqual({ ok: false, reason: "not_found" });
    // Another client's main contact, even with an open ask of their own, reaches none of these.
    const other = await scene("open-other");
    const otherId = await ask(other);
    await approveSealedAsk(owner(), otherId);
    const otherSession = randomUUID();
    await openDoor(other, otherSession);
    expect(await lookAtSealedLogin(other.at(other.carol.id, otherSession), s.sealed, "password", "reveal")).toEqual({
      ok: false,
      reason: "not_found",
    });
    // The client sees it open, and a new ask waits until it closes.
    expect((await readSealedPortalState(s.at(s.carol.id)))?.ask?.state.kind).toBe("open");
    expect(await askToOpenSealedLogins(s.at(s.carol.id), right, REASON)).toEqual({ ok: false, reason: "already" });
  });

  it("the job announces nothing twice: day 0 went with the ask, and an approval told everyone itself", async () => {
    const s = await scene("job");
    const waiting = await ask(s);
    const other = await scene("job-approved");
    const approved = await ask(other);
    await approveSealedAsk(owner(), approved);
    const before = await f.platform.emailOutbox.count({ where: { tenantId: f.tenantId } });
    const run = await sendSealedAskMail(f.tenantId);
    expect(run).toEqual({ reminders: 0, opened: 0 });
    expect(await f.platform.emailOutbox.count({ where: { tenantId: f.tenantId } })).toBe(before);
    expect((await f.platform.sealedOpenRequest.findUniqueOrThrow({ where: { id: waiting } })).remindersSent).toBe(1);
  });
});

describe("the job's reminders", () => {
  it("an ask owed a mail gets ONE, recorded and audited through the guard's bookkeeping rule — and the next run sends nothing", async () => {
    const s = await scene("remind");
    // Written raw, it carries no day-0 mail: the job owes it the first one.
    const made = await rawAsk(s);
    const before = await f.platform.sealedOpenRequest.findUniqueOrThrow({ where: { id: made.id } });
    expect(before.remindersSent).toBe(0);
    await sendSealedAskMail(f.tenantId);
    const row = await f.platform.sealedOpenRequest.findUniqueOrThrow({ where: { id: made.id } });
    expect(row.remindersSent).toBe(1);
    expect(row.lastRemindedAt).not.toBeNull();
    // While the wait runs, the waiting reminder's words, to every answerer.
    expect(await outbox("vault.sealed_open_reminder", made.id)).toEqual([{ receiverType: "MEMBER", receiverId: f.seats.owner.memberId }]);
    const audit = (await f.audits("credential.open_request_reminded")).filter((a) => a.targetId === made.id);
    expect(audit.map((a) => a.metadata)).toEqual([{ clientId: s.clientId, kind: "reminder", reminder: 1, receivers: 1 }]);
    // Run again: nothing more is owed today.
    await sendSealedAskMail(f.tenantId);
    expect((await f.platform.sealedOpenRequest.findUniqueOrThrow({ where: { id: made.id } })).remindersSent).toBe(1);
    expect(await outbox("vault.sealed_open_reminder", made.id)).toHaveLength(1);
    expect(await withdrawSealedAsk(s.at(s.carol.id), made.id)).toEqual({ ok: true });
  });
});

describe("withdrawing and confirming", () => {
  it("a main contact withdraws an ask that has not opened; another may then be made at once", async () => {
    const s = await scene("withdraw");
    const id = await ask(s);
    expect(await withdrawSealedAsk(s.at(s.dan.id), id).catch((e) => (e instanceof AuthzError ? e.reason : e))).toBe("FORBIDDEN");
    expect(await withdrawSealedAsk(s.at(s.carol.id), id)).toEqual({ ok: true });
    expect(await withdrawSealedAsk(s.at(s.carol.id), id)).toEqual({ ok: true }); // idempotent
    // The client's main contacts are told — a withdrawal needs only a session, and must not be silent.
    expect(await outbox("portal.sealed_open_news", id)).toEqual([{ receiverType: "CONTACT", receiverId: s.carol.id }]);
    expect((await readSealedPortalState(s.at(s.carol.id)))?.ask?.state.kind).toBe("withdrawn");
    expect(await outcome(approveSealedAsk(owner(), id))).toBe("SEALED_REQUEST_SETTLED");
    await ask(s);
    // Another client's contact cannot touch it.
    const other = await scene("withdraw-other");
    expect(await withdrawSealedAsk(other.at(other.carol.id), id)).toEqual({ ok: false, reason: "not_found" });
  });

  it("a confirmation before the wait has run is refused — by the service, and by the database", async () => {
    const s = await scene("early");
    const id = await ask(s);
    expect(await confirmSealedAsk(s.at(s.carol.id), id)).toEqual({ ok: false, reason: "not_yet" });
    const now = await dbNow();
    const raw = withTenant(f.tenantId, { type: "system" }, (tx) =>
      tx.sealedOpenRequest.update({
        where: { id },
        data: {
          confirmedAt: now,
          confirmedByContactId: s.carol.id,
          opensAt: new Date(now.getTime() + 48 * 3_600_000),
          openUntil: new Date(now.getTime() + (48 + 168) * 3_600_000),
        },
        select: { id: true },
      }),
    );
    // The wait rule's own refusal — not the door check after it, which would refuse too.
    expect(await guardSays(raw, "comes after the wait")).toBe(true);
    // And nothing to confirm through the door: with the switch off and nothing open or confirmable, the door has no purpose.
    expect(await startPortalLoginsDoor(s.at(s.carol.id), right, compose)).toEqual({ ok: false, reason: "off" });
  });
});

describe("the SYSTEM side restates the contact's standing", () => {
  it("with the vault module closed, an ask is refused even on the contact's stale open gates", async () => {
    const s = await scene("closed");
    await setModuleEnabled(owner(), "vault", false);
    try {
      expect(await askToOpenSealedLogins(s.at(s.carol.id), right, REASON)).toEqual({ ok: false, reason: "off" });
      expect(await readSealedPortalState(s.at(s.carol.id))).toBeNull();
      expect(await portalHasSealedLogins(s.principal(s.carol.id))).toBe(false);
    } finally {
      await setModuleEnabled(owner(), "vault", true);
    }
  });

  it("a contact no longer a main one is refused, though their own proof was made a moment ago", async () => {
    const s = await scene("demoted");
    const id = await ask(s);
    await f.platform.contact.update({ where: { id: s.carol.id }, data: { portalProfile: "CONTACT_COLLABORATOR" } });
    // Stale gates, a stale profile in the principal: only the broker's restatement can refuse.
    const r = await withdrawSealedAsk(s.at(s.carol.id), id).catch((e: unknown) =>
      e instanceof AuthzError ? e.reason : Promise.reject(e),
    );
    // Refused by their own proof (the profile, read afresh) or by the broker's restatement — never done.
    expect(r === "FORBIDDEN" || (typeof r === "object" && r.ok === false && r.reason === "off")).toBe(true);
    expect((await f.platform.sealedOpenRequest.findUniqueOrThrow({ where: { id } })).withdrawnAt).toBeNull();
  });
});
