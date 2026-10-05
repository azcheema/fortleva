import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { resetTenantDekCache } from "@/crypto/tenant-key";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { setTransport, type MailTransport } from "@/mailer";
import { actorFor, noMfa, setupTenant } from "@/members/dbtest-fixture";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { updatePreferences } from "@/preferences/service";
import { resetLocalLimiter } from "@/ratelimit";

import {
  approveSealedAsk,
  askToOpenSealedLogins,
  confirmSealedAsk,
  createCredential,
  denySealedAsk,
  listSealedPortalLogins,
  lookAtSealedLogin,
  openPortalLoginsDoor,
  readPortalLoginsDoor,
  readSealedPortalState,
  sealLogin,
  sendSealedAskMail,
  startPortalLoginsDoor,
  type LoginsCodeMail,
  type OpenPortalDoor,
  type PasswordCheck,
} from "./index";

/**
 * THE SILENT PATH, IN TIME (Phase 3V slice 93b; founder decision of
 * 2026-10-06). `sealed.dbtest.ts` cannot reach an ask whose wait has run:
 * the guard lets no writer backdate one, and that is the point of it. So
 * this file plants such an ask in its own throwaway tenant through the
 * database's OWNER connection (`DIRECT_URL`) with `session_replication_role
 * = replica` — each setup statement in a transaction of its own, the
 * setting dying with it; ordinary triggers are off for it, and so are
 * FOREIGN-KEY checks (Postgres runs them as triggers too — a plant must
 * use ids the test made, or it would leave an orphan no cascade cleans);
 * CHECKs stay on — and then drives the REAL services through
 * the REAL guard: the reminder after the wait, the confirmation through a
 * door opened after it, a denial in the 48 hours and none after, the job's
 * "it has opened", the client's view of what opened, the lapse, a closed
 * window. Nothing in the product changes; the guard is untouched.
 *
 * WHERE IT RUNS: only where planting is meant to happen — in CI (`CI` is
 * set), or where `DBTEST_ALLOW_REPLICA=1` says so deliberately — AND the
 * owner is a superuser (`session_replication_role` needs one): CI's
 * throwaway database's owner is (`.github/workflows/ci.yml`), the dev
 * database's is not. So locally the file SKIPS without even connecting, and
 * in CI it FAILS rather than skip if the owner is not a superuser, so it
 * cannot quietly stop running. Being a superuser alone is not enough (the
 * review's low): a future self-hosted database's owner may be one too.
 */

const directUrl = process.env["DIRECT_URL"];
const inCi = process.env["CI"] === "true";
const allowed = inCi || process.env["DBTEST_ALLOW_REPLICA"] === "1";

let owner: pg.Client | null = null;
let superuser = false;
if (allowed && directUrl) {
  owner = new pg.Client({ connectionString: directUrl });
  // A dropped idle connection must fail a test, not crash the worker.
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
  throw new Error("sealed-time.dbtest: CI's owner connection must be a superuser — this file must not skip in CI");
}

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;

const RUN = randomUUID().slice(0, 8);
const emailOf = (name: string) => `vstime-${name}-${RUN}@test.invalid`;
const ownerCtx = () => ({ tenantId: f.tenantId, actor: actorFor(f.seats.owner.memberId) });

const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};
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
const mailbox: { to: string; text: string }[] = [];
let previousTransport: MailTransport | undefined;
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
  at: (contactId: string, sessionId?: string) => { principal: PortalPrincipal; sessionId: string };
};

/** A client of its own: a main contact, one SEALED login (sealed `sealedHoursAgo` back), one plain one. */
const scene = async (label: string, sealedHoursAgo = 0): Promise<Scene> => {
  const clientId = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: `Time ${label}` } });
  const carol = { id: randomUUID(), email: emailOf(`${label}-carol`) };
  await f.platform.contact.create({
    data: {
      id: carol.id,
      tenantId: f.tenantId,
      clientId,
      name: `Carol ${label}`,
      email: carol.email,
      portalProfile: "CONTACT_PRIMARY",
      portalStatus: "ACTIVE",
      invitedAt: new Date("2026-09-01T09:00:00Z"),
      emailVerified: true,
    },
  });
  const make = (name: string, password: string) =>
    createCredential(ownerCtx(), { clientId, type: "LOGIN", name, url: "https://panel.example.test", secret: { password } });
  const sealed = (await make(`Sealed ${label}`, `sealed-${label}-${RUN}`)).id;
  const plain = (await make(`Plain ${label}`, `plain-${label}-${RUN}`)).id;
  await sealLogin(ownerCtx(), sealed);
  if (sealedHoursAgo > 0) {
    await planted("UPDATE credential_item SET sealed_at = now() - make_interval(hours => $2) WHERE id = $1", [sealed, sealedHoursAgo]);
  }
  const principal = (contactId: string): PortalPrincipal => ({ contactId, tenantId: f.tenantId, clientId, gates });
  return { clientId, sealed, plain, carol, at: (contactId, sessionId = randomUUID()) => ({ principal: principal(contactId), sessionId }) };
};

/**
 * ONE SETUP STATEMENT as the owner with triggers (foreign keys included)
 * off — the only way an ask can lie in the past. Its own transaction, so
 * the setting dies with it.
 */
async function planted(sql: string, params: unknown[]): Promise<void> {
  if (!owner) throw new Error("no superuser owner connection");
  await owner.query("BEGIN");
  try {
    await owner.query("SET LOCAL session_replication_role = replica");
    await owner.query(sql, params);
    await owner.query("COMMIT");
  } catch (e) {
    await owner.query("ROLLBACK");
    throw e;
  }
}

/**
 * Plant an ask of Carol's, every stamp in HOURS BEFORE NOW on the
 * database's clock (null = not made). The CHECKs still hold it to a shape
 * the machine could have produced; the guard is what is skipped.
 */
async function plantAsk(
  s: Scene,
  h: {
    asked: number;
    waitDays?: number;
    confirmed?: number;
    approved?: number;
    remindersSent?: number;
    lastReminded?: number;
    noticeAt?: number;
  },
): Promise<string> {
  const id = randomUUID();
  // ONE statement: the CHECKs are judged per statement, so the opening
  // they require — the approval itself, or the confirmation + 48 hours,
  // seven days long — is written with the stamps, from the same `now()`.
  await planted(
    `WITH t AS (
       SELECT now() - make_interval(hours => $6::int) AS asked,
              CASE WHEN $7::int IS NULL THEN NULL ELSE now() - make_interval(hours => $7::int) END AS confirmed,
              CASE WHEN $8::int IS NULL THEN NULL ELSE now() - make_interval(hours => $8::int) END AS approved,
              CASE WHEN $11::int IS NULL THEN NULL ELSE now() - make_interval(hours => $11::int) END AS notice,
              now() - make_interval(hours => $10::int) AS reminded
     )
     INSERT INTO sealed_open_request
       (id, tenant_id, client_id, asked_by_contact_id, reason, wait_days, asked_at, created_at,
        confirmed_at, confirmed_by_contact_id, approved_at, approved_by_member_id,
        opens_at, open_until, reminders_sent, last_reminded_at, opened_notice_at)
     SELECT $1, $2, $3, $4, 'Planted in the past by the time test.', $5::int, t.asked, t.asked,
            t.confirmed, CASE WHEN t.confirmed IS NULL THEN NULL ELSE $4 END,
            t.approved, CASE WHEN t.approved IS NULL THEN NULL ELSE $9 END,
            COALESCE(t.approved, t.confirmed + interval '48 hours'),
            COALESCE(t.approved, t.confirmed + interval '48 hours') + interval '168 hours',
            $12::int, t.reminded, t.notice
       FROM t`,
    [
      id,
      f.tenantId,
      s.clientId,
      s.carol.id,
      h.waitDays ?? 7,
      h.asked,
      h.confirmed ?? null,
      h.approved ?? null,
      f.seats.owner.memberId,
      h.lastReminded ?? h.asked,
      h.noticeAt ?? null,
      h.remindersSent ?? 1,
    ],
  );
  return id;
}

/** Open Carol's door in this session (her password, then the mailed code). */
const openDoor = async (s: Scene, sessionId: string): Promise<OpenPortalDoor> => {
  expect(await startPortalLoginsDoor(s.at(s.carol.id, sessionId), right, compose)).toEqual({ ok: true });
  expect((await openPortalLoginsDoor(s.at(s.carol.id, sessionId), lastCodeTo(s.carol.email))).ok).toBe(true);
  const state = await readPortalLoginsDoor(s.at(s.carol.id, sessionId));
  if (state.state !== "open") throw new Error("the door did not open");
  return state.door;
};

const outbox = (kind: string, requestId: string) =>
  f.platform.emailOutbox.findMany({
    where: { tenantId: f.tenantId, kind, params: { path: ["requestId"], equals: requestId } },
    select: { receiverType: true, receiverId: true },
  });
const ask = (id: string) => f.platform.sealedOpenRequest.findUniqueOrThrow({ where: { id } });

describe.skipIf(!superuser)("the silent path, in time (CI only — a superuser plants the past)", () => {
  beforeAll(async () => {
    f = await setupTenant("vstime");
    gates = await resolvePortalModuleGates(f.tenantId);
    previousTransport = setTransport(async (msg) => {
      mailbox.push({ to: msg.to, text: msg.text });
    });
    await updatePreferences(ownerCtx(), { vault: { revealBudgetPerHour: 100 } });
  }, 180_000);

  beforeEach(() => resetLocalLimiter());

  afterAll(async () => {
    if (previousTransport) setTransport(previousTransport);
    if (f) {
      await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
      await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
      await f.platform.credentialItem.updateMany({ where: { tenantId: f.tenantId }, data: { sealedAt: null } });
      await f.platform.credentialItem.deleteMany({ where: { tenantId: f.tenantId } });
      // Asks go with their client (FK cascade).
      await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
      await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
      await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
    }
    resetTenantDekCache();
    await f?.cleanup();
    await owner?.end();
  }, 180_000);

  it("after the wait: the reminder says the client can confirm; the client confirms through a door opened after it; it opens 48 hours on", async () => {
    const s = await scene("confirm");
    const id = await plantAsk(s, { asked: 8 * 24 });
    const before = await readSealedPortalState(s.at(s.carol.id));
    expect(before?.ask?.state.kind).toBe("confirmable");
    expect(before?.confirmReady).toBe(false);

    // The job: eight days on, one mail — in the words for a wait that has run.
    await sendSealedAskMail(f.tenantId);
    const reminded = await ask(id);
    expect(reminded.remindersSent).toBe(5); // day 0, 3, 6, 7, 8
    expect(await outbox("vault.sealed_open_confirmable", id)).toEqual([{ receiverType: "MEMBER", receiverId: f.seats.owner.memberId }]);
    expect(await outbox("vault.sealed_open_reminder", id)).toEqual([]);

    // Not without the door; then the door — it has a purpose (a confirmable ask) with the switch off.
    expect(await confirmSealedAsk(s.at(s.carol.id), id)).toEqual({ ok: false, reason: "locked" });
    const session = randomUUID();
    await openDoor(s, session);
    expect((await readSealedPortalState(s.at(s.carol.id, session)))?.confirmReady).toBe(true);
    // THE GUARD'S CONFIRMATION BRANCH, for real: after the wait, by an active main contact, through an open door.
    expect(await confirmSealedAsk(s.at(s.carol.id, session), id)).toEqual({ ok: true });
    const row = await ask(id);
    expect(row.confirmedByContactId).toBe(s.carol.id);
    expect(row.opensAt!.getTime() - row.confirmedAt!.getTime()).toBe(48 * 3_600_000);
    expect(row.openUntil!.getTime() - row.opensAt!.getTime()).toBe(168 * 3_600_000);
    expect(await outbox("vault.sealed_open_confirmed", id)).toEqual([{ receiverType: "MEMBER", receiverId: f.seats.owner.memberId }]);
    expect(await outbox("portal.sealed_open_news", id)).toEqual([{ receiverType: "CONTACT", receiverId: s.carol.id }]);
    expect((await f.audits("credential.open_request_confirmed")).some((a) => a.targetId === id && a.actorId === s.carol.id)).toBe(true);

    // Opening, not open: nothing to see yet; confirming again changes nothing.
    expect((await readSealedPortalState(s.at(s.carol.id, session)))?.ask?.state.kind).toBe("opening");
    expect(await lookAtSealedLogin(s.at(s.carol.id, session), s.sealed, "password", "reveal")).toEqual({ ok: false, reason: "not_found" });
    expect(await confirmSealedAsk(s.at(s.carol.id, session), id)).toEqual({ ok: true });
  });

  it("a door opened BEFORE the wait ran out confirms nothing — by the service and by the guard", async () => {
    const s = await scene("early-door");
    // Confirmable now, so the door has a purpose and opens…
    const id = await plantAsk(s, { asked: 8 * 24 });
    const session = randomUUID();
    await openDoor(s, session);
    // …then the wait is moved to end ONE SECOND AFTER that door opened, and
    // the second is let pass: confirmable again, through a door that predates it.
    await planted(
      `UPDATE sealed_open_request
          SET asked_at = (SELECT max(opened_at) FROM contact_vault_unlock WHERE contact_id = $2) + interval '1 second' - interval '168 hours',
              created_at = (SELECT max(opened_at) FROM contact_vault_unlock WHERE contact_id = $2) + interval '1 second' - interval '168 hours'
        WHERE id = $1`,
      [id, s.carol.id],
    );
    await new Promise((r) => setTimeout(r, 1500));
    const state = await readSealedPortalState(s.at(s.carol.id, session));
    expect(state?.ask?.state.kind).toBe("confirmable");
    expect(state?.confirmReady).toBe(false);
    expect(await confirmSealedAsk(s.at(s.carol.id, session), id)).toEqual({ ok: false, reason: "locked" });
    const now = (await f.platform.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() - interval '1 second' AS now`)[0]!.now;
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
    expect(await guardSays(raw, "through their open door")).toBe(true);
  });

  it("in the 48 hours an answerer may still deny (C61 (c)) — and once it has opened, nobody can", async () => {
    const s = await scene("deny-window");
    const id = await plantAsk(s, { asked: 9 * 24, confirmed: 1 });
    expect((await readSealedPortalState(s.at(s.carol.id)))?.ask?.state.kind).toBe("opening");
    // The job's reminder in these 48 hours is the agency's last chance to
    // deny, in its own words (the review's medium): one mail, nine days on.
    await sendSealedAskMail(f.tenantId);
    expect((await ask(id)).remindersSent).toBe(6); // day 0, 3, 6, 7, 8, 9
    expect(await outbox("vault.sealed_open_opening", id)).toEqual([{ receiverType: "MEMBER", receiverId: f.seats.owner.memberId }]);
    expect(await outbox("vault.sealed_open_confirmable", id)).toEqual([]);
    expect(await outbox("vault.sealed_open_reminder", id)).toEqual([]);
    await denySealedAsk({ tenantId: f.tenantId, actor: noMfa(f.seats.owner.memberId) }, id, "We are back — call us.");
    const denied = await ask(id);
    expect(denied.opensAt).toBeNull();
    expect((await readSealedPortalState(s.at(s.carol.id)))?.ask?.state.kind).toBe("denied");

    const later = await scene("too-late");
    const open = await plantAsk(later, { asked: 10 * 24, confirmed: 50 });
    expect((await readSealedPortalState(later.at(later.carol.id)))?.ask?.state.kind).toBe("open");
    expect(await outcome(denySealedAsk(ownerCtx(), open, null))).toBe("SEALED_REQUEST_SETTLED");
    expect(await outcome(approveSealedAsk(ownerCtx(), open))).toBe("SEALED_REQUEST_SETTLED");
    // The guard on its own: a member's denial after the opening.
    const now = (await f.platform.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() - interval '1 second' AS now`)[0]!.now;
    const raw = withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, (tx) =>
      tx.sealedOpenRequest.update({
        where: { id: open },
        data: { deniedAt: now, deniedByMemberId: f.seats.owner.memberId, opensAt: null, openUntil: null },
        select: { id: true },
      }),
    );
    expect(await guardSays(raw, "can no longer be answered")).toBe(true);
  });

  it("the 48 hours opened it: the job tells everyone once; behind the door the client sees what was sealed by the confirmation, and no more", async () => {
    // Sealed eleven days ago; confirmed 50 hours ago, so open for 2 hours now.
    const s = await scene("opened", 11 * 24);
    const id = await plantAsk(s, { asked: 10 * 24, confirmed: 50, remindersSent: 7, lastReminded: 24 });
    // A login sealed NOW, after the decision, stays shut (the reviews' medium).
    await sealLogin(ownerCtx(), s.plain);

    const run = await sendSealedAskMail(f.tenantId);
    expect(run.opened).toBeGreaterThanOrEqual(1);
    expect((await ask(id)).openedNoticeAt).not.toBeNull();
    expect(await outbox("vault.sealed_opened", id)).toEqual([{ receiverType: "MEMBER", receiverId: f.seats.owner.memberId }]);
    expect(await outbox("portal.sealed_open_news", id)).toEqual([{ receiverType: "CONTACT", receiverId: s.carol.id }]);
    // Once.
    await sendSealedAskMail(f.tenantId);
    expect(await outbox("vault.sealed_opened", id)).toHaveLength(1);

    const session = randomUUID();
    const door = await openDoor(s, session);
    const listed = await listSealedPortalLogins(s.at(s.carol.id, session), door);
    expect(listed?.logins.map((l) => l.id)).toEqual([s.sealed]);
    expect(await lookAtSealedLogin(s.at(s.carol.id, session), s.sealed, "password", "reveal")).toEqual({
      ok: true,
      value: `sealed-opened-${RUN}`,
    });
    expect(await lookAtSealedLogin(s.at(s.carol.id, session), s.plain, "password", "reveal")).toEqual({ ok: false, reason: "not_found" });
  });

  it("an unconfirmed ask lapses 30 days after its wait: no reminder, no confirmation, no answer — and a new ask may be made", async () => {
    const s = await scene("lapsed");
    const id = await plantAsk(s, { asked: 38 * 24, remindersSent: 3, lastReminded: 31 * 24 });
    const state = await readSealedPortalState(s.at(s.carol.id));
    expect(state?.ask?.state.kind).toBe("lapsed");
    expect(state?.canAsk).toBe(true);
    await sendSealedAskMail(f.tenantId);
    expect((await ask(id)).remindersSent).toBe(3);
    expect(await confirmSealedAsk(s.at(s.carol.id), id)).toEqual({ ok: false, reason: "settled" });
    expect(await outcome(denySealedAsk(ownerCtx(), id, null))).toBe("SEALED_REQUEST_SETTLED");
    // The guard on its own: a confirmation of a lapsed ask.
    const now = (await f.platform.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() - interval '1 second' AS now`)[0]!.now;
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
    expect(await guardSays(raw, "can no longer be answered")).toBe(true);
    expect(await askToOpenSealedLogins(s.at(s.carol.id), right, "Asking again.")).toEqual({ ok: true });
  });

  it("a window that has closed locks again: nothing to look at, and a new ask may be made at once", async () => {
    const s = await scene("closed", 21 * 24);
    await plantAsk(s, { asked: 20 * 24, approved: 19 * 24, noticeAt: 19 * 24 });
    const state = await readSealedPortalState(s.at(s.carol.id));
    expect(state?.ask?.state.kind).toBe("closed");
    expect(state?.canAsk).toBe(true);
    // The door has no purpose (the switch is off, nothing open or confirmable).
    expect(await startPortalLoginsDoor(s.at(s.carol.id), right, compose)).toEqual({ ok: false, reason: "off" });
    expect(await askToOpenSealedLogins(s.at(s.carol.id), right, "Again, please.")).toEqual({ ok: true });
  });
});
