import { record } from "@/audit/record";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { fail } from "@/lib/domain-error";
import { emit } from "@/notify/emit";
import { authorizePortal, withPortalRead, type PortalPrincipal, type PortalScopeRef } from "@/portal";
import { lockContactBudget } from "@/portal/contact-budget-lock";
import { readPreferences } from "@/preferences/service";
import { allow } from "@/ratelimit";

import { submitterStanding } from "./contact-standing";
import { boundedVaultWrite } from "./ctx";
import {
  isCredentialType,
  NAME_MAX,
  normalizeNotes,
  normalizeSecretFields,
  normalizeUrl,
  normalizeUsername,
  trimmedOrNull,
  URL_MAX,
  type CredentialType,
} from "./fields";
import { insertSubmittedCredential } from "./submission";
import { submissionReceivers } from "./submission-receivers";

/**
 * A CLIENT HANDS A LOGIN OVER — THE PORTAL'S SUBMISSION BROKER (Phase 3V
 * slice 96; founder decision C64; AUTHZ.md §8's `portal.credential.submit`,
 * a brokered write).
 *
 * A contact — a main contact or a helper, both profiles hold the
 * capability — fills in "Send us a login" on their portal (C64 (a)): what
 * it is, a name, optionally the project it is for, a username and web
 * address, the secret itself, a note. It goes straight into the agency's
 * vault on that client (or that project), FOR THE TEAM ONLY — INTERNAL,
 * never shown back, no member as its author, `submittedByContactId` naming
 * who sent it — and the client's people are told, by name of the client
 * only (C64 (c), `submission-receivers.ts`). Afterwards each person sees
 * their OWN list of what they sent — the name AS THEY SENT IT and a date,
 * never the secret, never the name the team may give it later (C64 (b),
 * `readPortalSubmissions`). New logins only: a changed password is sent as
 * a new one (C64 (d)).
 *
 * THE SHAPE IS THE BROKER'S (`src/modules/work/portal-writes.ts` has the
 * long form): the contact's OWN transaction proves the capability and the
 * resource (`withPortalRead` + `authorizePortal`, the project as the ref
 * when one was picked, else the client), and only then a SYSTEM
 * transaction writes — restating what it relies on, because RLS no longer
 * does: both modules open and the contact still an active, invited
 * contact of this client holding the capability (`submitterStanding`,
 * which locks the contact's row so ending their access waits for this to
 * commit), the agency still taking logins (`vault.allowContactSubmission`),
 * the client not archived, and a picked project still that client's, its
 * portal on, not archived. Every column that identifies anything is
 * derived here — the client is the principal's, never the form's.
 *
 * THE BUDGET IS A POSTGRES COUNT of the contact's own `credential.submitted`
 * rows under their budget lock (`lockContactBudget`) — fail-closed with or
 * without Upstash, whose limiter is only the cheap filter in front:
 * `SUBMISSIONS_PER_HOUR`, and `SUBMISSIONS_PER_DAY` because an hourly
 * bound alone renews forever. A client onboarding with a dozen logins fits;
 * a script does not.
 *
 * THE DATABASE HOLDS THE REST for any writer (migration 20261006180000):
 * only SYSTEM sets the column, the login is born INTERNAL, unsealed, live
 * and seedless, by an active contact of its own client, and who sent it
 * never changes.
 *
 * NOTHING HERE RETURNS A SECRET, and no error carries a value
 * (`fields.ts` names keys, never what was typed); nothing logs.
 */

/** Logins one contact may hand over per rolling hour… */
export const SUBMISSIONS_PER_HOUR = 20;
/** …and per rolling day. */
export const SUBMISSIONS_PER_DAY = 60;
/** How many of their own hand-overs a contact's list shows, newest first. */
export const SENT_LIST_LIMIT = 50;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** What the "Send us a login" form posts — nothing that names a tenant, a client or a contact. */
export type PortalLoginInput = {
  readonly type: unknown;
  readonly name: unknown;
  /** A project of the contact's own client, or null for the company itself. */
  readonly projectId: unknown;
  readonly username: unknown;
  readonly url: unknown;
  readonly notes: unknown;
  /** The type's secret fields by key; empty values are dropped. */
  readonly secret: unknown;
};

/**
 * One login this contact handed over, as their own list shows it: the name
 * as THEY sent it (`submittedName`, which never changes) and when. No id,
 * and nothing the agency did with it since — renamed, binned, shown — is
 * readable from it.
 */
export type SentLogin = { readonly name: string; readonly sentAt: Date };

export type PortalSubmissions = {
  /** Whether this contact may hand a login over now. */
  readonly open: boolean;
  /** What they sent, newest first — whether or not the agency is taking logins now. */
  readonly sent: readonly SentLogin[];
};

type Parsed = {
  readonly type: CredentialType;
  readonly name: string;
  readonly projectId: string | null;
  readonly username: string | null;
  readonly url: string | null;
  readonly notes: string | null;
  readonly fields: Record<string, string>;
};

/**
 * A web address as a client types it: "example.com/admin" is meant as
 * https. Anything already carrying a scheme's `://` is left for
 * `normalizeUrl` to judge (http and https only).
 */
function portalUrl(raw: unknown): string | null {
  const v = trimmedOrNull(raw, URL_MAX, "url");
  if (v === null) return null;
  // A scheme at the START, never "://" anywhere: `example.com/?next=https://x`
  // is still an address without one (the security review's nit).
  return normalizeUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
}

/**
 * THE INPUT, PARSED BEFORE ANYTHING IS AUTHORIZED — the request broker's
 * one deviation from "authorize first", for its reason: what the reader
 * typed is theirs to be told about (`INVALID_INPUT` is disclosable), and an
 * empty form opens no transaction.
 */
function parseInput(input: PortalLoginInput): Parsed {
  if (!isCredentialType(input.type)) fail("INVALID_INPUT", "type");
  const type = input.type as CredentialType;
  const name = trimmedOrNull(input.name, NAME_MAX, "name");
  if (name === null) fail("INVALID_INPUT", "name");
  // An id that is not a non-empty string is refused, never passed on:
  // Prisma drops an `undefined` filter silently, and the re-read below runs
  // under a principal no policy narrows.
  let projectId: string | null = null;
  if (input.projectId !== null && input.projectId !== undefined && input.projectId !== "") {
    if (typeof input.projectId !== "string" || input.projectId.length > 64) fail("INVALID_INPUT", "project");
    projectId = input.projectId as string;
  }
  const fields = normalizeSecretFields(type, input.secret);
  if (Object.keys(fields).length === 0) fail("INVALID_INPUT", "a login needs a secret");
  return {
    type,
    name: name as string,
    projectId,
    username: normalizeUsername(input.username),
    url: portalUrl(input.url),
    notes: normalizeNotes(input.notes),
    fields,
  };
}

/**
 * Whether the agency takes logins from this contact now — the SYSTEM side
 * of the answer: the contact's standing (`submitterStanding`), then the
 * agency's switch and the client not archived.
 */
async function takingLogins(tx: TenantDb, principal: PortalPrincipal, lock: boolean): Promise<boolean> {
  if (!(await submitterStanding(tx, principal, { lock }))) return false;
  return agencyTakingLogins(tx, principal);
}

/** The agency's half: sending switched on, and the client not archived. */
async function agencyTakingLogins(tx: TenantDb, principal: PortalPrincipal): Promise<boolean> {
  const prefs = await readPreferences(tx, principal.tenantId);
  if (!prefs.vault.allowContactSubmission) return false;
  const client = await tx.client.findFirst({
    where: { tenantId: principal.tenantId, id: principal.clientId, status: { not: "ARCHIVED" } },
    select: { id: true },
  });
  return client !== null;
}

/**
 * The picked project as it stands NOW: still this client's, its portal
 * still on, not archived — written out, because no policy answers a SYSTEM
 * read.
 */
async function projectOpen(tx: TenantDb, principal: PortalPrincipal, projectId: string): Promise<boolean> {
  const project = await tx.project.findFirst({
    where: {
      tenantId: principal.tenantId,
      id: projectId,
      clientId: principal.clientId,
      portalEnabled: true,
      archivedAt: null,
      status: { not: "ARCHIVED" },
    },
    select: { id: true },
  });
  return project !== null;
}

/**
 * Has this contact spent their budget as of `now`? Their own
 * `credential.submitted` rows in the last hour, then the last day.
 */
async function overBudget(tx: TenantDb, principal: PortalPrincipal, now: Date): Promise<boolean> {
  const sentSince = (ms: number) =>
    tx.auditEvent.count({
      where: {
        tenantId: principal.tenantId,
        actorType: "CONTACT",
        actorId: principal.contactId,
        action: "credential.submitted",
        createdAt: { gte: new Date(now.getTime() - ms) },
      },
    });
  if ((await sentSince(HOUR_MS)) >= SUBMISSIONS_PER_HOUR) return true;
  return (await sentSince(DAY_MS)) >= SUBMISSIONS_PER_DAY;
}

/**
 * HAND A LOGIN OVER (`portal.credential.submit`). Resolves when it is in
 * the vault; refuses with `INVALID_INPUT` (what they typed),
 * `SUBMISSION_RATE_LIMITED` (their own pace — both disclosable), `VAULT_BUSY`
 * (lock waits spent) or the plane's one NOT_FOUND for everything about the
 * agency (sending switched off, the module, a project no longer open to
 * them, their access ended).
 */
export async function submitPortalCredential(principal: PortalPrincipal, input: PortalLoginInput): Promise<void> {
  const parsed = parseInput(input);
  // The cheap filter in front of the fail-closed count below — a no-op
  // without Upstash, and not the control.
  if (!(await allow("portal.credential_submit", principal.contactId))) {
    fail("SUBMISSION_RATE_LIMITED", "front filter");
  }
  const ref: PortalScopeRef =
    parsed.projectId === null
      ? { kind: "client", clientId: principal.clientId }
      : { kind: "project", projectId: parsed.projectId };
  await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.credential.submit", ref));

  // WHO WILL BE TOLD, read before the write and outside its locks (the
  // design review's low): each member's codes and scope are a handful of
  // reads apiece, and holding the contact's row and budget key across them
  // would stretch the window an ending of access waits in. The anchor is
  // the request's, proved the contact's to name just above; the write
  // re-reads it, and a write that is refused tells nobody. Everything that
  // would refuse it is asked FIRST, unlocked — a spent budget (the delta
  // review's low), and every "closed": the contact's standing, the agency's
  // switch, the client, the project (the security review's low) — so a
  // refused attempt, which writes nothing and so is never counted, never
  // pays for the lookup either. The locked re-checks inside the write stay
  // the ones that hold.
  const anchor = { clientId: principal.clientId, projectId: parsed.projectId };
  const pre = await withTenant(principal.tenantId, { type: "system" }, async (tx) => {
    if (!(await takingLogins(tx, principal, false))) return "closed" as const;
    if (parsed.projectId !== null && !(await projectOpen(tx, principal, parsed.projectId))) return "closed" as const;
    if (await overBudget(tx, principal, new Date())) return "limited" as const;
    return submissionReceivers(tx, principal.tenantId, anchor);
  });
  if (pre === "limited") return fail("SUBMISSION_RATE_LIMITED", "budget spent");
  if (pre === "closed") return deny("NOT_FOUND", "not taking logins from this contact");
  const receivers = pre;

  const outcome = await boundedVaultWrite((opts) =>
    withTenant(
      principal.tenantId,
      { type: "system" },
      async (tx): Promise<"ok" | "limited" | "closed"> => {
        // The budget's lock first, then the contact's row (inside
        // `takingLogins`), then the login's rows — one order, always.
        const now = await lockContactBudget(tx, "portal_credential_submit", principal.contactId);
        if (!(await takingLogins(tx, principal, true))) return "closed";
        if (parsed.projectId !== null && !(await projectOpen(tx, principal, parsed.projectId))) return "closed";
        if (await overBudget(tx, principal, now)) return "limited";

        const created = await insertSubmittedCredential(tx, {
          tenantId: principal.tenantId,
          clientId: anchor.clientId,
          projectId: anchor.projectId,
          contactId: principal.contactId,
          type: parsed.type,
          name: parsed.name,
          username: parsed.username,
          url: parsed.url,
          notes: parsed.notes,
          fields: parsed.fields,
        });
        await record(tx, {
          action: "credential.submitted",
          targetType: "CredentialItem",
          targetId: created.id,
          // The CONTACT is the actor — the system transaction only carried it.
          brokeredForContactId: principal.contactId,
          // Ids, the type and the field NAMES — never a value, never the name
          // (an audit row outlives the login and is read by operators).
          metadata: {
            clientId: anchor.clientId,
            projectId: anchor.projectId,
            type: parsed.type,
            fields: Object.keys(parsed.fields),
          },
        });
        await emit(tx, principal.tenantId, {
          kind: "credential.submitted",
          // The CLIENT, never the login: the inbox names the client to a
          // reader who can open one of its logins, and which one stays
          // behind the vault's door (C54). One unread row per client, so a
          // client sending a dozen logins in a sitting is one message.
          entity: { type: "Client", id: anchor.clientId },
          clientId: anchor.clientId,
          memberIds: receivers,
          params: { clientId: anchor.clientId },
          dedupeKey: `credential_submitted:${anchor.clientId}`,
        });
        return "ok";
      },
      opts,
    ),
  );
  if (outcome === "limited") fail("SUBMISSION_RATE_LIMITED", "budget spent");
  if (outcome === "closed") deny("NOT_FOUND", "not taking logins from this contact");
}

/**
 * MAY THIS CONTACT HAND A LOGIN OVER NOW? — the one bit the portal's home
 * asks to draw "Send us a login" (rendered by View-as too, for the contact
 * being looked through, which answers the same). A brokered READ: the
 * switch is a tenant preference, which a contact's own transaction cannot
 * read. False for every refusal — the plane's quiet answer.
 */
export async function portalCanSendLogins(principal: PortalPrincipal): Promise<boolean> {
  await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.credential.submit"));
  return withTenant(principal.tenantId, { type: "system" }, (tx) => takingLogins(tx, principal, false));
}

/**
 * THE "SEND US A LOGIN" PAGE'S READ (C64 (b)): whether this contact may
 * hand a login over, and what THEY handed over — the name as they sent it
 * and when, newest first, never anything else. A brokered READ: the logins
 * are INTERNAL, so a contact's own transaction reads none of them. Bounded
 * by this contact and this client.
 *
 * WHAT THE AGENCY DID WITH IT SINCE IS NOT READABLE HERE (the design
 * review's high and its nit): the name is the frozen `submittedName`, never
 * `name`, which a member may rename into words a client must not read; the
 * list counts binned logins too, so it never says when the agency binned
 * one; and it stands whether or not the agency is taking logins now, so the
 * switch is never told by a list emptying. Only the contact's own standing
 * (their access, the capability, both modules) closes it. Nothing happened,
 * so nothing is audited.
 */
export async function readPortalSubmissions(principal: PortalPrincipal): Promise<PortalSubmissions> {
  await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.credential.submit"));
  return withTenant(principal.tenantId, { type: "system" }, async (tx) => {
    if (!(await submitterStanding(tx, principal, { lock: false }))) return { open: false, sent: [] };
    const open = await agencyTakingLogins(tx, principal);
    const rows = await tx.credentialItem.findMany({
      where: {
        tenantId: principal.tenantId,
        clientId: principal.clientId,
        submittedByContactId: principal.contactId,
      },
      select: { submittedName: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: SENT_LIST_LIMIT,
    });
    return {
      open,
      sent: rows.flatMap((r) => (r.submittedName === null ? [] : [{ name: r.submittedName, sentAt: r.createdAt }])),
    };
  });
}
