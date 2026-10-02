/* eslint-disable no-restricted-imports -- sanctioned auth-layer consumer
   of the raw client (TENANCY.md §6.3): Session and Verification are
   AUTH-class rows. */
import { runtimeClient } from "@/db/client";
import { absoluteUrl } from "@/config";
import { send } from "@/mailer";

import { deviceLabel, networkOf, type DeviceKind } from "./device-label";
import { auth } from "./index";

/**
 * "YOUR DEVICES", THE SIGN-OUT PURGE AND THE BACKUP-CODE COUNT (slice 84,
 * founder decision C50) — the IO half of `/account`'s new cards and of the
 * owner's verbs in `./member-reset`.
 *
 * Every read here is of the CALLER'S OWN account: the user id comes from
 * the session at the call site, never from a form.
 */

/** What a session row may tell the screen — never its token. */
export type DeviceRow = {
  readonly id: string;
  readonly current: boolean;
  readonly browser: string | null;
  readonly os: string | null;
  readonly kind: DeviceKind;
  readonly network: string | null;
  /** A session of the ops console (the same account, the other plane). */
  readonly console: boolean;
  readonly signedInAt: Date;
  /**
   * The row's last write: Better Auth refreshes a session at most once a
   * day (`updateAge`), and the product's own stamps (a step-up, a
   * workspace switch) write it too — so "within a day", never "now".
   */
  readonly lastActiveAt: Date;
};

/** More than any one person holds; the list is a recognition aid, not an export. */
const DEVICE_LIST_CAP = 50;

export async function listOwnDevices(userId: string, currentSessionId: string): Promise<DeviceRow[]> {
  const rows = await runtimeClient.session.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    // Never `token`: a session's token is its credential.
    select: { id: true, userAgent: true, ipAddress: true, plane: true, createdAt: true, updatedAt: true },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: DEVICE_LIST_CAP,
  });
  const devices = rows.map((r) => {
    const label = deviceLabel(r.userAgent);
    return {
      id: r.id,
      current: r.id === currentSessionId,
      browser: label.browser,
      os: label.os,
      kind: label.kind,
      network: networkOf(r.ipAddress),
      console: r.plane === "PLATFORM",
      signedInAt: r.createdAt,
      lastActiveAt: r.updatedAt,
    };
  });
  // This device first, however stale its row: it is the one the reader
  // is holding, and the list is read against it.
  return [...devices.filter((d) => d.current), ...devices.filter((d) => !d.current)];
}

/** The two delegates a purge touches — the raw client's, or a tenant transaction's. */
export type SessionPurgeDb = {
  readonly session: typeof runtimeClient.session;
  readonly verification: typeof runtimeClient.verification;
};

/**
 * THE ONE SIGN-OUT PURGE, for every path that ends sessions on purpose in
 * this slice — a device signed out, "everywhere else", the factor
 * replaced, an owner's sign-out or reset. It ends the sessions (all, or
 * all but `keepSessionId`) AND:
 *
 *  - **every trusted-device mark** (`trust-device-…`). A mark lets the
 *    password alone skip the second factor for thirty days, and a mark
 *    names no session or device, so it cannot be ended for one device
 *    only. The product never offers "trust this device" (no screen sends
 *    `trustDevice`), so a mark can only have been made by a direct call —
 *    somebody who once had the password AND a code. Ending them all costs
 *    a member nothing.
 *  - **every sign-in waiting for a code** (`2fa-…`, value = the user id):
 *    somebody past the password on another device. The `2fa-attempts-…`
 *    counters carry a count in `value`, so they are never matched.
 *
 * RUNBOOK §8's sign-out statement, for one account. Returns the number of
 * sessions ended.
 */
export async function endSessions(db: SessionPurgeDb, userId: string, keepSessionId: string | null): Promise<number> {
  const { count } = await db.session.deleteMany({
    where: keepSessionId === null ? { userId } : { userId, id: { not: keepSessionId } },
  });
  await endMarks(db, userId);
  return count;
}

/** The trusted-device marks and the sign-ins waiting for a code (above). */
async function endMarks(db: SessionPurgeDb, userId: string): Promise<void> {
  await db.verification.deleteMany({
    where: {
      value: userId,
      OR: [{ identifier: { startsWith: "trust-device-" } }, { identifier: { startsWith: "2fa-" } }],
    },
  });
}

/**
 * Sign ONE of the caller's own sessions out — never the current one (the
 * ordinary sign-out does that) and never anybody else's: the delete is
 * keyed on the session id AND the caller's user id, so another account's
 * id matches nothing and answers like an unknown one. The purge's marks
 * and waiting sign-ins go with it (above: they cannot be ended for one
 * device only). One transaction, so a device is never half signed out.
 */
export async function signOutOwnDevice(
  userId: string,
  sessionId: string,
  currentSessionId: string,
): Promise<boolean> {
  if (sessionId === currentSessionId) return false;
  return runtimeClient.$transaction(async (tx) => {
    const { count } = await tx.session.deleteMany({ where: { id: sessionId, userId } });
    if (count === 0) return false;
    await endMarks(tx, userId);
    return true;
  });
}

/** "Sign out everywhere else" for the caller: the purge, keeping this session. */
export const signOutOtherDevices = (userId: string, currentSessionId: string): Promise<number> =>
  runtimeClient.$transaction((tx) => endSessions(tx, userId, currentSessionId));

/** At or below this many unused backup codes, `/account` says to issue more. */
export const LOW_BACKUP_CODES = 3;

/**
 * How many unused backup codes the caller holds — a COUNT, never the
 * codes. Better Auth's `viewBackupCodes` is server-only (its router
 * refuses it over HTTP) and decrypts the set; this is its one caller, and
 * the codes go no further than this function. Null when the account has
 * no factor or the set cannot be read — the page then says nothing,
 * rather than a number it does not have.
 */
export async function backupCodesLeft(userId: string): Promise<number | null> {
  try {
    const result = await auth.api.viewBackupCodes({ body: { userId } });
    const codes = (result as { backupCodes?: unknown }).backupCodes;
    return Array.isArray(codes) ? codes.length : null;
  } catch {
    return null;
  }
}

/**
 * THE MAILS. Links, not data (ARC-09): what happened, when, and where to
 * go — never a code, a token or a password. English, like every other auth
 * mail (the mailer has no locale yet). Each is sent AFTER the change has
 * committed, by a caller that catches a failure: an unsent mail must
 * never undo, or hide, a change that already happened.
 */
const when = (at: Date): string => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export async function mailFactorReplaced(to: string, at: Date, proof: "totp" | "backup_code"): Promise<void> {
  // What the person who did it held besides the password — said as it was,
  // because "one of your backup codes" is wrong for a member moving phones
  // (the fix-pass review's low), and a phished live code is the other case.
  const held = proof === "backup_code" ? "one of your backup codes" : "a code from your authenticator app";
  await send({
    to,
    subject: "Your Fortleva two-factor authenticator was replaced",
    text:
      `Hello,\n\n` +
      `The authenticator app for the Fortleva account at this address was replaced at ${when(at)}, ` +
      `new backup codes were issued, and every other device was signed out.\n\n` +
      `If that was you, there is nothing more to do.\n\n` +
      `If it was not, somebody has your password and ${held}. ` +
      `Choose a new password now (${absoluteUrl("/reset-password")}) and tell an owner of your workspace, ` +
      `who can reset your two-factor authentication.`,
  });
}

/*
 * NO NAME IN THE OWNER'S MAILS — neither the owner's nor the workspace's —
 * for `./member-recovery`'s reason: both are text somebody typed, and a
 * mail from our domain must not carry a sentence of their choosing. The
 * member's own audit trail (and the owner, whom they can ask) says who.
 */

export async function mailTwoFactorResetByOwner(to: string, at: Date): Promise<void> {
  await send({
    to,
    subject: "Your Fortleva two-factor authentication was reset",
    text:
      `Hello,\n\n` +
      `An owner of your Fortleva workspace reset the two-factor authentication on your account at ${when(at)}, ` +
      `and you were signed out on every device.\n\n` +
      `Sign in (${absoluteUrl("/login")}) and set up two-factor authentication again straight away: ` +
      `until you do, your password alone opens your account.\n\n` +
      `If you did not ask for this, tell your workspace's owners at once — by phone or in person, not by email.`,
  });
}

export async function mailSignedOutByOwner(to: string, at: Date): Promise<void> {
  await send({
    to,
    subject: "You were signed out of Fortleva on every device",
    text:
      `Hello,\n\n` +
      `An owner of a Fortleva workspace you belong to signed you out on every device at ${when(at)}.\n\n` +
      `Sign in again when you are ready: ${absoluteUrl("/login")}\n\n` +
      `If you did not expect this, ask your workspace's owners why.`,
  });
}
