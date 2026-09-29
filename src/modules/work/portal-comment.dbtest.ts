import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { setupTenant } from "@/members/dbtest-fixture";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";

import { createComment, deleteComment, updateComment } from "./comments";
import { describeError } from "./dbtest-locks";
import {
  assignItem,
  assignItemToContact,
  changeItemVisibility,
  createItem,
  deleteItem,
  getItemDetail,
  setItemArchived,
} from "./items";
import { PORTAL_REPLY_WINDOW_DAYS, listPortalAgencyReplies, readPortalTask } from "./portal";
import {
  createPortalComment,
  PORTAL_COMMENT_WINDOW_LIMIT,
  PORTAL_COMMENT_WINDOW_MINUTES,
} from "./portal-comment";
import { createPortalRequest } from "./portal-writes";
import { changeState } from "./states";
import { triageItem } from "./triage";
import { makeItemPrivate } from "./visibility";

/**
 * A CLIENT'S COMMENT ON A SHARED TASK against the real schema, the real
 * `app_runtime` role and a real contact principal (Phase 3 slice 75;
 * founder decisions C37, C41–C43): `createPortalComment` — the census
 * write under the contact's OWN principal — its after-commit
 * announcement (`comment-announce.ts`), and `readPortalTask`, the task
 * page's projection of the task and its conversation.
 *
 * WHAT ONLY A DATABASE CAN SAY, and therefore why this file exists:
 *
 *  · THE WRITE IS THE CONTACT'S. The comment row, its audit row and the
 *    principal that wrote them are read back past RLS: CLIENT_VISIBLE,
 *    authored by the contact and nobody else, `portal_enabled` stamped
 *    true, the audit actor CONTACT with ids and never the words — and
 *    the history row and the inbox row the SYSTEM adds after the commit.
 *  · "IF YOU CAN SEE THE TASK, YOU CAN COMMENT ON IT" (C41), BOTH WAYS.
 *    Every row the portal's list would hide — INTERNAL, another
 *    client's, a switched-off or archived project, live work archived, a
 *    cancelled task, a deleted one — is refused NOT_FOUND by the writer
 *    AND by the page, and an answered request, archived or not, is
 *    admitted by both. Each refusal is followed by a census of the
 *    tenant's comments, history rows, inbox rows, outbox rows and audit
 *    rows: a refusal that wrote anything anywhere fails.
 *  · THE ORDER OF LOCKS IS OBSERVED, NOT ASSUMED. The comment is SEEN in
 *    `pg_locks` queued for the project's portal gate (slice 74) behind a
 *    switch, and queued on the task's row behind a make-private, before
 *    either holder moves — so a writer that did not wait fails as "the
 *    race was not exercised", not as a green test that proved nothing.
 *  · THE CENSUS, MEASURED RAW under the contact's own principal: a
 *    contact may insert only a CLIENT_VISIBLE comment signed by
 *    themself, and may neither rewrite nor delete it afterwards.
 *
 * THE SENTINEL WALK, as in every portal suite: an internal note, a
 * deleted reply, another task's comments and another client's comment
 * carry strings that exist nowhere else, and the serialised task page is
 * searched for every one of them — and for the replying member's name,
 * address and ids, which the page signs "Your agency".
 *
 * Tenant slugs come from `setupTenant("pcomm")`, and the prefix `pcomm-`
 * is registered in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts) so
 * `sweep-dbtests` can collect this suite's orphans. `e2e-` is the
 * BROWSER harness's prefix and is swept by AGE — a dbtest using it would
 * have its fixtures deleted mid-run by a concurrent e2e run.
 */

const run = randomUUID().slice(0, 8);

const KIND = "work_item.client_commented";
const ACTION = "portal.comment_created";
/** The portal gate's advisory seed (migration 20260928180000, §1). */
const G = 7401;

/** A case that makes many service calls over the transatlantic link (DB_TX_TIMEOUT_MS widens the budgets 4×). */
const CASE_MS = 180_000;
/** A held transaction's Prisma budget — longer than any wait it outlives (withTenant scales it by the link factor). */
const HOLD_MS = 60_000;
/** How long a probe watches before it calls the race unexercised. */
const PROBE_MS = 15_000;
/** How long a waiting comment is watched NOT finishing, once it has been seen waiting. */
const STILL_WAITING_MS = 500;

/** Strings that exist nowhere but on a row a contact must never read. */
const S = {
  internalNote: `SENTINELINTERNALNOTE-${run}`,
  deletedReply: `SENTINELDELETEDREPLY-${run}`,
  otherTaskReply: `SENTINELOTHERTASKREPLY-${run}`,
  otherTaskOwn: `SENTINELOTHERTASKOWN-${run}`,
  betaComment: `SENTINELBETACOMMENT-${run}`,
} as const;

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;

let acme: string;
let beta: string;
/** Portal ON. Lead: the manager seat. People: the employee seat and the (suspended) admin seat. */
let pOn: string;
/** Portal OFF. */
let pOff: string;
/** Portal ON, then ARCHIVED — `project`'s own `portal_gate` does not separate the two. */
let pArchived: string;
/** Beta's, portal ON, nobody on it. */
let pBeta: string;
/** Two portal-ON projects, one per gate case — the first ends switched off. */
let pGateA: string;
let pGateB: string;
let projectKey: string;
let projectName: string;

/** Carol — ACTIVE, CONTACT_PRIMARY, of acme. The commenter in almost every case. */
let carol: string;
/** Dan — ACTIVE, CONTACT_COLLABORATOR, of acme. Carol's colleague: both profiles hold `portal.comment.create`. */
let dan: string;
/** Sue — SUSPENDED, of acme. */
let sue: string;
/** Bo — ACTIVE, of beta. */
let bo: string;
/** Eva and Frida — ACTIVE, of acme, the budget case's own two, so no other case's comments are in their counts. */
let eva: string;
let frida: string;
/** The C45 block's own writer, so its comments spend no other case's budget (code review, slice 76). */
let gil: string;

/** Rows the portal's list does not show — every one refused by the writer and by the page. */
let hidden: ReadonlyArray<readonly [label: string, id: string]>;
/** A shared task whose MEMBER assignee was then suspended (the admin seat). */
let suspendedAssigneeTask: Task;

type Task = { readonly id: string; readonly number: number };
type Principal = Parameters<typeof withTenant>[1];

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });

const principal = (contactId: string, clientId = acme): PortalPrincipal => ({
  contactId,
  tenantId: f.tenantId,
  clientId,
  gates,
});

/** The paragraph document the writer builds from one line of text. */
const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A live task through the real service — shared unless asked otherwise. */
async function newTask(title: string, opts: { projectId?: string; shared?: boolean } = {}): Promise<Task> {
  const { id, number } = await createItem(ownerCtx(), {
    projectId: opts.projectId ?? pOn,
    title: `${title} ${run}`,
    visibility: opts.shared === false ? "INTERNAL" : "CLIENT_VISIBLE",
  });
  return { id, number };
}

const stateOf = async (projectId: string, seedKey: "CANCELLED") =>
  (
    await f.platform.workflowState.findFirstOrThrow({
      where: { tenantId: f.tenantId, projectId, seedKey },
      select: { id: true },
    })
  ).id;

const authzReason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    throw e;
  }
};

const domainCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

/**
 * EVERYTHING A COMMENT CAN WRITE, tenant-wide: the rows, the history
 * rows, the inbox and outbox rows of its kind, and its audit rows. A
 * refusal is followed by this and compared to the count before it —
 * tenant-wide, so a write that landed on the WRONG task fails too.
 */
async function census() {
  const tenantId = f.tenantId;
  return {
    comments: await f.platform.comment.count({ where: { tenantId } }),
    history: await f.platform.workItemActivity.count({ where: { tenantId, field: "comment" } }),
    inbox: await f.platform.notification.count({ where: { tenantId, kind: KIND } }),
    outbox: await f.platform.emailOutbox.count({ where: { tenantId, kind: KIND } }),
    audited: await f.platform.auditEvent.count({ where: { tenantId, action: ACTION } }),
  };
}

/** Refused as the uniform NOT_FOUND, and nothing written anywhere. */
async function expectNotFound(p: () => Promise<unknown>, label: string): Promise<void> {
  const before = await census();
  expect(await authzReason(p()), label).toBe("NOT_FOUND");
  expect(await census(), `${label}: nothing written`).toEqual(before);
}

const expectNoSentinel = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const [name, sentinel] of Object.entries(S)) {
    expect(json, `sentinel ${name} leaked`).not.toContain(sentinel);
  }
};

/** The inbox rows of this kind about one task. */
const toldAbout = (itemId: string) =>
  f.platform.notification.findMany({
    where: { tenantId: f.tenantId, kind: KIND, entityId: itemId },
    select: { id: true, receiverId: true, readAt: true, params: true, actorType: true, actorId: true },
  });

const receiversOf = async (itemId: string) => (await toldAbout(itemId)).map((n) => n.receiverId).sort();

/** The project's people with the admin seat suspended: its lead and its one ACTIVE assignee. */
const projectPeople = () => [f.seats.manager.memberId, f.seats.employee.memberId].sort();

// ── Holding a transaction open (portal-switch-gate.dbtest.ts' shape) ──

type Held = {
  /** Resolves once `body` has run, with the holder's 32-bit transaction id when one is assigned. */
  readonly ready: Promise<{ readonly xid: string | null }>;
  readonly release: () => void;
  /** Settles when the holder has committed (after running `after`, still inside). */
  readonly done: Promise<void>;
};

/** A colleague's transaction: runs `body`, stays open until released, runs `after` inside it, commits. */
function hold(body: (tx: TenantDb) => Promise<unknown>, after?: (tx: TenantDb) => Promise<unknown>): Held {
  const who: Principal = { type: "member", id: f.seats.owner.memberId };
  let signal!: (held: { xid: string | null }) => void;
  let release!: () => void;
  const signalled = new Promise<{ xid: string | null }>((r) => (signal = r));
  const released = new Promise<void>((r) => (release = r));
  const done = withTenant(
    f.tenantId,
    who,
    async (tx) => {
      await body(tx);
      const [me] = await tx.$queryRaw<{ xid: string | null }[]>`
        SELECT (txid_current_if_assigned() % 4294967296)::text AS xid`;
      signal({ xid: me?.xid ?? null });
      await released;
      if (after) await after(tx);
    },
    { timeoutMs: HOLD_MS },
  );
  const ready = Promise.race([
    signalled,
    done.then((): never => {
      throw new Error("the held transaction ended without signalling");
    }),
  ]);
  return { ready, release, done };
}

/** A call's outcome without ever rejecting — so it can be held open, watched, and inspected later. */
type Outcome<T> = { readonly settled: boolean; readonly value?: T; readonly error?: unknown };
function watch<T>(p: Promise<T>): { readonly state: () => Outcome<T>; readonly finished: Promise<Outcome<T>> } {
  let outcome: Outcome<T> = { settled: false };
  const finished = p.then(
    (value) => (outcome = { settled: true, value }),
    (error: unknown) => (outcome = { settled: true, error }),
  );
  return { state: () => outcome, finished };
}

/**
 * THE RACE: `call` must be SEEN waiting before it settles. A call that
 * settles first — because it never waited — fails at once, with its own
 * error when it threw, never as a probe timeout that hides the cause.
 */
async function mustWait(
  call: { readonly state: () => Outcome<unknown>; readonly finished: Promise<Outcome<unknown>> },
  what: string,
  seen: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + PROBE_MS;
  while (Date.now() < deadline) {
    const s = call.state();
    if (s.settled) {
      throw new Error(
        `${what}: the call finished without waiting — the race was not exercised (${s.error ? describeError(s.error) : "it succeeded"})`,
      );
    }
    if (await seen()) return;
    await pause(25);
  }
  throw new Error(`${what} was never seen — the race was not exercised`);
}

/** Requests for project P's portal gate in THIS database, by mode and grant — the key derived inline, as the migration's helpers derive it. */
async function gateRequests(projectId: string, mode: "ShareLock" | "ExclusiveLock", granted: boolean): Promise<number> {
  const rows = await f.platform.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks
     WHERE locktype = 'advisory' AND objsubid = 2
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid::bigint = ((hashtextextended(${projectId}::text, ${G}::int8) >> 32) & 4294967295)
       AND objid::bigint = (hashtextextended(${projectId}::text, ${G}::int8) & 4294967295)
       AND mode = ${mode} AND granted = ${granted}::boolean`;
  return rows[0]?.n ?? 0;
}

/** Some transaction blocked on the one with this id — a row lock's wait. */
async function waitingOn(xid: string): Promise<boolean> {
  const rows = await f.platform.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks
     WHERE NOT granted AND locktype = 'transactionid' AND transactionid::text = ${xid}`;
  return (rows[0]?.n ?? 0) > 0;
}

// ── Fixture ───────────────────────────────────────────────────────────

beforeAll(async () => {
  f = await setupTenant("pcomm");
  acme = randomUUID();
  beta = randomUUID();
  pOn = randomUUID();
  pOff = randomUUID();
  pArchived = randomUUID();
  pBeta = randomUUID();
  pGateA = randomUUID();
  pGateB = randomUUID();
  carol = randomUUID();
  dan = randomUUID();
  sue = randomUUID();
  bo = randomUUID();
  eva = randomUUID();
  frida = randomUUID();
  gil = randomUUID();
  const up = run.slice(0, 3).toUpperCase();
  projectKey = `PCO${up}`;
  projectName = `Site ${run}`;

  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  await f.platform.project.createMany({
    data: [
      {
        id: pOn,
        tenantId: f.tenantId,
        clientId: acme,
        key: projectKey,
        name: projectName,
        portalEnabled: true,
        leadMemberId: f.seats.manager.memberId,
      },
      { id: pOff, tenantId: f.tenantId, clientId: acme, key: `PCF${up}`, name: `Off ${run}`, portalEnabled: false },
      // Archived AFTER its task is created (below): a task is created in a live project.
      { id: pArchived, tenantId: f.tenantId, clientId: acme, key: `PCR${up}`, name: `Archived ${run}`, portalEnabled: true },
      { id: pBeta, tenantId: f.tenantId, clientId: beta, key: `PCB${up}`, name: `Beta site ${run}`, portalEnabled: true },
      { id: pGateA, tenantId: f.tenantId, clientId: acme, key: `PCG${up}`, name: `Gate A ${run}`, portalEnabled: true },
      { id: pGateB, tenantId: f.tenantId, clientId: acme, key: `PCH${up}`, name: `Gate B ${run}`, portalEnabled: true },
    ],
  });
  // THE PROJECT'S PEOPLE (`requestReceivers`): the lead (manager) and two
  // assignees — the employee, and the admin seat, which is suspended
  // below so "ACTIVE only" has a row it must leave out.
  await f.platform.memberProject.createMany({
    data: [
      { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId: pOn },
      { tenantId: f.tenantId, memberId: f.seats.admin.memberId, projectId: pOn },
    ],
  });

  const invitedAt = new Date("2026-09-01T09:00:00Z");
  const contact = (id: string, clientId: string, name: string, profile: "CONTACT_PRIMARY" | "CONTACT_COLLABORATOR", status: "ACTIVE" | "SUSPENDED") => ({
    id,
    tenantId: f.tenantId,
    clientId,
    name,
    email: `pcomm-${name.toLowerCase()}-${run}@test.invalid`,
    portalProfile: profile,
    portalStatus: status,
    invitedAt,
    emailVerified: true,
  });
  await f.platform.contact.createMany({
    data: [
      contact(carol, acme, "Carol", "CONTACT_PRIMARY", "ACTIVE"),
      contact(dan, acme, "Dan", "CONTACT_COLLABORATOR", "ACTIVE"),
      contact(sue, acme, "Sue", "CONTACT_PRIMARY", "SUSPENDED"),
      contact(bo, beta, "Bo", "CONTACT_PRIMARY", "ACTIVE"),
      contact(eva, acme, "Eva", "CONTACT_PRIMARY", "ACTIVE"),
      contact(frida, acme, "Frida", "CONTACT_PRIMARY", "ACTIVE"),
      contact(gil, acme, "Gil", "CONTACT_PRIMARY", "ACTIVE"),
    ],
  });
  gates = await resolvePortalModuleGates(f.tenantId);

  // ── The rows the portal does not show, through the real services ────
  const internal = await newTask("Internal", { shared: false });
  const other = await newTask("Beta's", { projectId: pBeta });
  const off = await newTask("On a switched-off project", { projectId: pOff });
  const onArchived = await newTask("On an archived project", { projectId: pArchived });
  await f.platform.project.update({
    where: { id: pArchived },
    data: { archivedAt: new Date(), status: "ARCHIVED" },
    select: { id: true },
  });
  const archived = await newTask("Archived live work");
  await setItemArchived(ownerCtx(), archived.id, true);
  const cancelled = await newTask("Cancelled task");
  await changeState(ownerCtx(), cancelled.id, await stateOf(pOn, "CANCELLED"));
  const deleted = await newTask("Deleted");
  await deleteItem(ownerCtx(), deleted.id);
  hidden = [
    ["an INTERNAL task", internal.id],
    ["another client's task", other.id],
    ["a task on a project whose portal is OFF", off.id],
    ["a task on an ARCHIVED project", onArchived.id],
    ["a live task that was archived", archived.id],
    ["a CANCELLED ordinary task", cancelled.id],
    ["a soft-deleted task", deleted.id],
    ["an empty id", ""],
    ["a random id", randomUUID()],
    // What a hand-built server-action call can decode into an argument: a
    // Prisma FILTER, which without the type guard would pick some shown
    // task rather than the one named (slice 75's code review).
    ["a filter object instead of an id", { not: "" } as unknown as string],
  ];

  // ── The suspended assignee: assigned while ACTIVE, then suspended ───
  suspendedAssigneeTask = await newTask("Held by a suspended member");
  await assignItem(ownerCtx(), suspendedAssigneeTask.id, f.seats.admin.memberId);
  await f.platform.member.update({
    where: { id: f.seats.admin.memberId },
    data: { status: "SUSPENDED", suspendedAt: new Date() },
    select: { id: true },
  });
}, 300_000);

afterAll(async () => {
  // A beforeAll that threw leaves no tenant, and Prisma DROPS an
  // undefined where-filter: every delete below would be unscoped (the
  // 2026-08-31 dev-database wipe).
  if (!f?.tenantId) return;
  const tenantId = f.tenantId;
  const db = f.platform;
  await db.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId}`;
  await db.emailOutbox.deleteMany({ where: { tenantId } });
  await db.notification.deleteMany({ where: { tenantId } });
  await db.comment.deleteMany({ where: { tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId } });
  // Children before parents: `work_item.parent_id` is ON DELETE RESTRICT (every task here is a root).
  await db.workItem.deleteMany({ where: { tenantId, parentId: { not: null } } });
  await db.workItem.deleteMany({ where: { tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId } });
  // `nextCounter` mints a `tenant_counter` row per project, RESTRICT to `tenant`.
  await db.tenantCounter.deleteMany({ where: { tenantId } });
  await db.memberProject.deleteMany({ where: { tenantId } });
  await db.contact.deleteMany({ where: { tenantId } });
  await db.project.deleteMany({ where: { tenantId } });
  await db.client.deleteMany({ where: { tenantId } });
  await db.tenantPreference.deleteMany({ where: { tenantId } });
  await f.cleanup();
}, 180_000);

// ═══════════════════════════════════════════════════════════════════════

describe("a client comments on a shared task", () => {
  it(
    "writes ONE row as the contact, audits the contact with ids only, and the SYSTEM adds the history and the inbox rows",
    async () => {
      const t = await newTask("Shared with the client");
      const text = `Could you also check the footer contrast? ${run}`;
      const out = await createPortalComment(principal(carol), t.id, text);
      expect(Object.keys(out).sort()).toEqual(["createdAt", "id", "itemId"]);
      expect(out.itemId).toBe(t.id);

      // THE ROW, read past RLS.
      const rows = await f.platform.comment.findMany({ where: { tenantId: f.tenantId, subjectId: t.id } });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({
        id: out.id,
        subjectType: "WORK_ITEM",
        clientId: acme,
        projectId: pOn,
        visibility: "CLIENT_VISIBLE",
        authorContactId: carol,
        authorMemberId: null,
        bodyText: text,
        portalEnabled: true,
        parentId: null,
        editedAt: null,
        deletedAt: null,
      });
      expect(row.body).toEqual(doc(text));
      expect(row.createdAt.getTime()).toBe(out.createdAt.getTime());

      // THE AUDIT ROW — the contact's own, inside the census transaction.
      const audits = (await f.audits(ACTION)).filter((a) => a.targetId === out.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorType: "CONTACT", actorId: carol, targetType: "Comment", visibility: "TENANT" });
      expect(audits[0]!.metadata).toEqual({ workItemId: t.id, projectId: pOn, clientId: acme });
      expect(JSON.stringify(audits[0])).not.toContain(text);

      // THE HISTORY ROW — the system's, naming the CONTACT and no member.
      const history = await f.platform.workItemActivity.findMany({
        where: { tenantId: f.tenantId, workItemId: t.id, field: "comment" },
      });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        newValue: "created",
        commentId: out.id,
        actorContactId: carol,
        actorMemberId: null,
        visibility: "INTERNAL",
      });

      // THE INBOX ROW — ids only, no actor (no employee did this).
      const told = await toldAbout(t.id);
      expect(told.map((n) => n.receiverId).sort()).toEqual(projectPeople());
      for (const n of told) {
        expect(n.actorType).toBeNull();
        expect(n.actorId).toBeNull();
        expect(n.params).toEqual({ projectKey, itemNumber: String(t.number) });
      }
      expect(JSON.stringify(told)).not.toContain(text);

      // THE MEMBER PANEL draws it from the row, signed by the contact.
      const detail = await getItemDetail(ownerCtx(), pOn, t.number);
      const entry = detail.comments.rows.find((c) => c.id === out.id);
      expect(entry).toMatchObject({
        author: { kind: "contact", name: "Carol" },
        visibility: "CLIENT_VISIBLE",
        own: false,
        canEdit: false,
      });
      expect(entry!.body).toEqual(doc(text));
    },
    CASE_MS,
  );
});

describe("who at the agency is told (C43: owner, else project)", () => {
  it(
    "the task's ACTIVE member assignee and nobody else — one unread row however many comments arrive",
    async () => {
      const t = await newTask("Owned by the owner");
      // The OWNER seat is on no project list, so "only them" can be told
      // apart from "the project's people".
      await assignItem(ownerCtx(), t.id, f.seats.owner.memberId);
      await createPortalComment(principal(carol), t.id, `First ${run}`);
      expect(await receiversOf(t.id)).toEqual([f.seats.owner.memberId]);

      // THE DEDUPE: a second comment while the first row is unread adds no row.
      await createPortalComment(principal(dan), t.id, `Second ${run}`);
      const told = await toldAbout(t.id);
      expect(told).toHaveLength(1);
      expect(await f.platform.comment.count({ where: { tenantId: f.tenantId, subjectId: t.id } })).toBe(2);

      // …and once it is READ, the next comment is news again.
      await f.platform.notification.update({ where: { id: told[0]!.id }, data: { readAt: new Date() }, select: { id: true } });
      await createPortalComment(principal(carol), t.id, `Third ${run}`);
      expect(await toldAbout(t.id)).toHaveLength(2);
    },
    CASE_MS,
  );

  it(
    "an unassigned task: the project's lead and assignees, ACTIVE only",
    async () => {
      const t = await newTask("Nobody's yet");
      await createPortalComment(principal(carol), t.id, `Anyone? ${run}`);
      // The admin seat is on the project and SUSPENDED: left out.
      expect(await receiversOf(t.id)).toEqual(projectPeople());
      expect(await receiversOf(t.id)).not.toContain(f.seats.admin.memberId);
    },
    CASE_MS,
  );

  it(
    "an assignee who is SUSPENDED: the project's people instead",
    async () => {
      await createPortalComment(principal(carol), suspendedAssigneeTask.id, `Hello? ${run}`);
      expect(await receiversOf(suspendedAssigneeTask.id)).toEqual(projectPeople());
    },
    CASE_MS,
  );

  it(
    "a task handed to a CONTACT has no member owner: the project's people",
    async () => {
      const t = await newTask("Handed to the client");
      await assignItemToContact(ownerCtx(), t.id, carol);
      await createPortalComment(principal(carol), t.id, `Done my part ${run}`);
      expect(await receiversOf(t.id)).toEqual(projectPeople());
    },
    CASE_MS,
  );
});

describe("if you can see the task, you can comment on it (C41) — and nothing else", () => {
  it(
    "refuses every row the portal's list does not show, as NOT_FOUND, and writes nothing anywhere",
    async () => {
      for (const [label, id] of hidden) {
        await expectNotFound(() => createPortalComment(principal(carol), id, `Refused ${run}`), label);
      }
    },
    CASE_MS,
  );

  it(
    "refuses a contact of ANOTHER client on this client's task — and admits that contact on their own",
    async () => {
      const t = await newTask("Acme's");
      await expectNotFound(() => createPortalComment(principal(bo, beta), t.id, `Not mine ${run}`), "Bo on Acme's task");
      // THE POSITIVE TWIN: Bo's own client's task, on a project with
      // nobody on it — the comment lands and nobody is told (C43's
      // recorded empty case), which is also the sentinel the page walk
      // below looks for on Acme's side.
      const betaTask = hidden.find(([label]) => label === "another client's task")![1];
      const out = await createPortalComment(principal(bo, beta), betaTask, S.betaComment);
      expect(out.itemId).toBe(betaTask);
      expect(await toldAbout(betaTask)).toEqual([]);
      expect(
        await f.platform.workItemActivity.count({ where: { tenantId: f.tenantId, workItemId: betaTask, field: "comment" } }),
      ).toBe(1);
    },
    CASE_MS,
  );

  it(
    "refuses a SUSPENDED contact, and writes nothing",
    async () => {
      const t = await newTask("Suspended reader");
      const before = await census();
      const err = await createPortalComment(principal(sue), t.id, `Still here ${run}`).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AuthzError);
      expect(await census()).toEqual(before);
    },
    CASE_MS,
  );

  it(
    "ADMITS an answered request — declined, and still after it is archived (an answer outlives the tidying)",
    async () => {
      const req = await createPortalRequest(principal(carol), {
        projectId: pOn,
        title: `Could you add a blog? ${run}`,
        body: null,
      });
      const reason = `Not in this year's plan ${run}`;
      await triageItem({ tenantId: f.tenantId, actor: f.seats.manager.actor }, req.id, { verb: "DECLINE", reason });
      const declined = await f.platform.workItem.findUniqueOrThrow({
        where: { id: req.id },
        select: { stateCategory: true, kind: true, triageReason: true },
      });
      expect(declined).toEqual({ stateCategory: "CANCELLED", kind: "REQUEST", triageReason: reason });

      const first = await createPortalComment(principal(carol), req.id, `Why not? ${run}`);
      expect(first.itemId).toBe(req.id);

      await setItemArchived(ownerCtx(), req.id, true);
      const second = await createPortalComment(principal(carol), req.id, `Next year then ${run}`);
      expect(second.itemId).toBe(req.id);

      const page = await readPortalTask(principal(carol), req.id);
      expect(page.task).toMatchObject({ category: "DECLINED", reply: reason });
      expect(page.comments.map((c) => c.id)).toEqual([first.id, second.id]);
    },
    CASE_MS,
  );
});

describe("what the contact typed", () => {
  it(
    "refuses nothing but whitespace, too long, not text, a document, and an unstorable character — INVALID_INPUT, nothing written",
    async () => {
      const t = await newTask("Input");
      const nul = String.fromCharCode(0);
      const cases: ReadonlyArray<readonly [string, unknown]> = [
        ["empty", ""],
        ["whitespace only", "   \n\t"],
        ["4001 characters", "x".repeat(4001)],
        ["a number", 123],
        // PLAIN TEXT, NEVER A DOCUMENT FROM THE BROWSER (portal-comment-input.ts).
        ["a ProseMirror document", doc(`Smuggled ${run}`)],
        ["a NUL character", `before${nul}after ${run}`],
      ];
      for (const [label, input] of cases) {
        const before = await census();
        expect(await domainCode(createPortalComment(principal(carol), t.id, input)), label).toBe("INVALID_INPUT");
        expect(await census(), `${label}: nothing written`).toEqual(before);
      }
    },
    CASE_MS,
  );

  it(
    "accepts exactly 4000 characters, stored as typed",
    async () => {
      const t = await newTask("Long input");
      const text = "y".repeat(4000);
      const out = await createPortalComment(principal(carol), t.id, text);
      const row = await f.platform.comment.findUniqueOrThrow({ where: { id: out.id }, select: { bodyText: true } });
      expect(row.bodyText).toBe(text);
    },
    CASE_MS,
  );
});

describe("the comment budget", () => {
  const plant = async (taskId: string, contactId: string, n: number, createdAt?: Date) =>
    f.platform.comment.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        tenantId: f.tenantId,
        subjectType: "WORK_ITEM" as const,
        subjectId: taskId,
        authorContactId: contactId,
        body: doc(`Planted ${i} ${run}`),
        bodyText: `Planted ${i} ${run}`,
        visibility: "CLIENT_VISIBLE" as const,
        ...(createdAt ? { createdAt } : {}),
      })),
    });

  it(
    `refuses a contact's comment past ${PORTAL_COMMENT_WINDOW_LIMIT} inside the window — COMMENT_RATE_LIMITED, nothing written`,
    async () => {
      const t = await newTask("Budget spent");
      // Stamped by the DATABASE's clock (the column default) — the clock
      // the budget reads.
      await plant(t.id, eva, PORTAL_COMMENT_WINDOW_LIMIT);
      const before = await census();
      expect(await domainCode(createPortalComment(principal(eva), t.id, `One more ${run}`))).toBe("COMMENT_RATE_LIMITED");
      expect(await census()).toEqual(before);
    },
    CASE_MS,
  );

  it(
    "counts only the window: older comments are free, and the limit is the limit",
    async () => {
      const t = await newTask("Budget window");
      const [clock] = await f.platform.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
      const old = new Date(clock!.now.getTime() - (PORTAL_COMMENT_WINDOW_MINUTES + 5) * 60_000);
      await plant(t.id, frida, PORTAL_COMMENT_WINDOW_LIMIT, old);
      await plant(t.id, frida, PORTAL_COMMENT_WINDOW_LIMIT - 1);
      // The LIMIT-th inside the window is admitted — the old ones are not counted…
      const out = await createPortalComment(principal(frida), t.id, `Last one ${run}`);
      expect(out.itemId).toBe(t.id);
      // …and the one after it is not.
      const before = await census();
      expect(await domainCode(createPortalComment(principal(frida), t.id, `Past it ${run}`))).toBe("COMMENT_RATE_LIMITED");
      expect(await census()).toEqual(before);
    },
    CASE_MS,
  );
});

describe("the project's portal gate (slice 74): a comment waits a switch out", () => {
  it(
    "a switch in flight that ends OFF: the comment WAITS on the gate, then is refused NOT_FOUND — nothing written",
    async () => {
      const t = await newTask("Mid-switch, off", { projectId: pGateA });
      const before = await census();
      const holder = hold(
        (tx) => tx.$executeRaw`SELECT portal_switch_begin(${pGateA})`,
        // The switch's own fan-out, inside the transaction that holds the gate.
        (tx) => tx.$executeRaw`UPDATE project SET portal_enabled = false WHERE tenant_id = ${f.tenantId} AND id = ${pGateA}`,
      );
      let call: ReturnType<typeof watch<unknown>> | null = null;
      try {
        await holder.ready;
        call = watch(createPortalComment(principal(carol), t.id, `During the switch ${run}`));
        await mustWait(call, "the comment queued SHARED on the project's gate", async () =>
          (await gateRequests(pGateA, "ShareLock", false)) > 0,
        );
        await pause(STILL_WAITING_MS);
        expect(call.state().settled, "the comment finished while the switch still held the gate").toBe(false);
      } finally {
        holder.release();
        await holder.done;
      }
      const outcome = await call!.finished;
      expect(outcome.settled).toBe(true);
      // The switch ended OFF, and the writer re-read the task after the
      // gate: the uniform refusal. (REQUEST_BUSY would mean every lock
      // wait was spent — the hold above is far inside one.)
      expect(outcome.error, describeError(outcome.error)).toBeInstanceOf(AuthzError);
      expect((outcome.error as AuthzError).reason).toBe("NOT_FOUND");
      expect(await census()).toEqual(before);
    },
    CASE_MS,
  );

  it(
    "a switch in flight that changes nothing: the comment WAITS, then lands — portal_enabled TRUE on the row",
    async () => {
      // WITHOUT THE GATE'S BLOCKING ENTRY this comment would have run on
      // while the switch held the gate exclusive: its stamp's TRY would
      // have failed, written `portal_enabled = false` (fail closed), and
      // `comment`'s portal_gate WITH CHECK — which demands the flag —
      // would have refused the contact's own INSERT as a row-level
      // security violation (portal-switch-gate.dbtest.ts measures that
      // raw). Waiting the switch out is what lets it be born visible.
      const t = await newTask("Mid-switch, unchanged", { projectId: pGateB });
      const holder = hold((tx) => tx.$executeRaw`SELECT portal_switch_begin(${pGateB})`);
      let call: ReturnType<typeof watch<Awaited<ReturnType<typeof createPortalComment>>>> | null = null;
      try {
        await holder.ready;
        call = watch(createPortalComment(principal(carol), t.id, `During a no-op switch ${run}`));
        await mustWait(call, "the comment queued SHARED on the project's gate", async () =>
          (await gateRequests(pGateB, "ShareLock", false)) > 0,
        );
        await pause(STILL_WAITING_MS);
        expect(call.state().settled, "the comment finished while the switch still held the gate").toBe(false);
      } finally {
        holder.release();
        await holder.done;
      }
      const outcome = await call!.finished;
      expect(outcome.error, describeError(outcome.error)).toBeUndefined();
      const row = await f.platform.comment.findUniqueOrThrow({
        where: { id: outcome.value!.id },
        select: { portalEnabled: true, visibility: true, authorContactId: true },
      });
      expect(row).toEqual({ portalEnabled: true, visibility: "CLIENT_VISIBLE", authorContactId: carol });
      expect((await f.audits(ACTION)).filter((a) => a.targetId === outcome.value!.id)).toHaveLength(1);
    },
    CASE_MS,
  );
});

describe("the locked re-read", () => {
  it(
    "a make-private holding the task: the comment WAITS on the row, re-reads it, and is refused NOT_FOUND — nothing written",
    async () => {
      const t = await newTask("Going private");
      const before = await census();
      const holder = hold(
        (tx) => tx.$queryRaw`SELECT id FROM work_item WHERE tenant_id = ${f.tenantId} AND id = ${t.id} FOR UPDATE`,
        (tx) => tx.$executeRaw`UPDATE work_item SET visibility = 'INTERNAL' WHERE tenant_id = ${f.tenantId} AND id = ${t.id}`,
      );
      let call: ReturnType<typeof watch<unknown>> | null = null;
      try {
        const { xid } = await holder.ready;
        expect(xid, "a FOR UPDATE assigns the holder a transaction id").not.toBeNull();
        call = watch(createPortalComment(principal(carol), t.id, `Just in time ${run}`));
        await mustWait(call, "the comment queued on the task's row lock", () => waitingOn(xid!));
        await pause(STILL_WAITING_MS);
        expect(call.state().settled, "the comment finished while the task was held").toBe(false);
      } finally {
        holder.release();
        await holder.done;
      }
      const outcome = await call!.finished;
      expect(outcome.error, describeError(outcome.error)).toBeInstanceOf(AuthzError);
      expect((outcome.error as AuthzError).reason).toBe("NOT_FOUND");
      expect(await census()).toEqual(before);
      // The task really is private now — the refusal is about the row the lock handed back.
      expect((await f.platform.workItem.findUniqueOrThrow({ where: { id: t.id }, select: { visibility: true } })).visibility).toBe(
        "INTERNAL",
      );
    },
    CASE_MS,
  );
});

describe("the task page (readPortalTask)", () => {
  it(
    "refuses every row the list does not show, as NOT_FOUND — and a suspended contact",
    async () => {
      for (const [label, id] of hidden) {
        expect(await authzReason(readPortalTask(principal(carol), id)), label).toBe("NOT_FOUND");
      }
      const t = await newTask("Page for a suspended reader");
      await expect(readPortalTask(principal(sue), t.id)).rejects.toBeInstanceOf(AuthzError);
      expect(await authzReason(readPortalTask(principal(bo, beta), t.id))).toBe("NOT_FOUND");
    },
    CASE_MS,
  );

  it(
    "carries the task and its CLIENT_VISIBLE live comments, oldest first, signed as the client may be told — and nothing else",
    async () => {
      const t = await newTask("Thread");
      const other = await newTask("Another thread");

      const carolFirst = await createPortalComment(principal(carol), t.id, `Is the footer in scope? ${run}`);
      const reply = await createComment(ownerCtx(), t.id, {
        doc: doc(`It is now ${run}`),
        visibility: "CLIENT_VISIBLE",
      });
      const danNext = await createPortalComment(principal(dan), t.id, `Thanks! ${run}`);
      // Never on the page: an internal note, a deleted reply, another task's thread.
      await createComment(ownerCtx(), t.id, { doc: doc(S.internalNote), visibility: "INTERNAL" });
      const gone = await createComment(ownerCtx(), t.id, { doc: doc(S.deletedReply), visibility: "CLIENT_VISIBLE" });
      await deleteComment(ownerCtx(), gone.id);
      await createComment(ownerCtx(), other.id, { doc: doc(S.otherTaskReply), visibility: "CLIENT_VISIBLE" });
      await createPortalComment(principal(carol), other.id, S.otherTaskOwn);
      // The member corrects their reply after the client read it.
      const corrected = `It is now, footer included ${run}`;
      await updateComment(ownerCtx(), reply.id, { doc: doc(corrected) });

      const page = await readPortalTask(principal(carol), t.id);
      expect(Object.keys(page).sort()).toEqual(["canComment", "comments", "commentsTruncated", "project", "task"]);
      expect(page.project).toEqual({ key: projectKey, name: projectName });
      expect(page.task).toMatchObject({ id: t.id, title: `Thread ${run}`, category: "PLANNED", reply: null });
      expect(page.canComment).toBe(true);
      expect(page.commentsTruncated).toBe(false);

      // Oldest first, and exactly these three.
      expect(page.comments.map((c) => c.id)).toEqual([carolFirst.id, reply.id, danNext.id]);
      for (let i = 1; i < page.comments.length; i++) {
        expect(page.comments[i]!.createdAt.getTime()).toBeGreaterThanOrEqual(page.comments[i - 1]!.createdAt.getTime());
      }
      const [mine, agency, colleague] = page.comments;
      expect(Object.keys(mine!).sort()).toEqual(["author", "body", "createdAt", "edited", "id"]);
      expect(mine!.author).toEqual({ kind: "contact", name: "Carol", you: true });
      expect(mine!.body).toEqual(doc(`Is the footer in scope? ${run}`));
      expect(mine!.edited).toBe(false);
      // THE AGENCY IS NOBODY IN PARTICULAR (C42): no name, no id.
      expect(agency!.author).toEqual({ kind: "agency" });
      expect(agency!.body).toEqual(doc(corrected));
      expect(agency!.edited).toBe(true);
      expect(colleague!.author).toEqual({ kind: "contact", name: "Dan", you: false });
      expect(colleague!.edited).toBe(false);

      // THE SENTINEL WALK — and the replying member, who is on this page
      // only as "Your agency".
      expectNoSentinel(page);
      const json = JSON.stringify(page);
      const owner = await f.platform.user.findUniqueOrThrow({
        where: { id: f.seats.owner.userId },
        select: { name: true, email: true },
      });
      for (const [what, value] of [
        ["member id", f.seats.owner.memberId],
        ["user id", f.seats.owner.userId],
        ["member name", owner.name],
        ["member email", owner.email],
      ] as const) {
        expect(json, `${what} leaked`).not.toContain(value);
      }

      // The colleague reads the same thread, with `you` turned round.
      const forDan = await readPortalTask(principal(dan), t.id);
      expect(forDan.canComment).toBe(true);
      expect(forDan.comments.map((c) => c.author)).toEqual([
        { kind: "contact", name: "Carol", you: false },
        { kind: "agency" },
        { kind: "contact", name: "Dan", you: true },
      ]);
      expectNoSentinel(forDan);
    },
    CASE_MS,
  );
});

describe("a client's comment follows its task (C37)", () => {
  it(
    "goes private with the task — off the page, and the writer refuses — and comes back with the re-share",
    async () => {
      const t = await newTask("Private for a while");
      const c = await createPortalComment(principal(carol), t.id, `Before it went private ${run}`);

      const out = await makeItemPrivate(ownerCtx(), t.id);
      expect(out).toMatchObject({ visibility: "INTERNAL", changed: true });
      expect(out.alsoPrivate).toMatchObject({ comments: 1 });
      const lowered = await f.platform.comment.findUniqueOrThrow({
        where: { id: c.id },
        select: { visibility: true, authorContactId: true, deletedAt: true },
      });
      expect(lowered).toEqual({ visibility: "INTERNAL", authorContactId: carol, deletedAt: null });
      expect(await authzReason(readPortalTask(principal(carol), t.id))).toBe("NOT_FOUND");
      await expectNotFound(() => createPortalComment(principal(carol), t.id, `After ${run}`), "a task made private");

      await changeItemVisibility(ownerCtx(), t.id, "CLIENT_VISIBLE");
      const raised = await f.platform.comment.findUniqueOrThrow({ where: { id: c.id }, select: { visibility: true } });
      expect(raised.visibility).toBe("CLIENT_VISIBLE");
      const page = await readPortalTask(principal(carol), t.id);
      expect(page.comments.map((x) => x.id)).toEqual([c.id]);
      expect(page.comments[0]!.author).toEqual({ kind: "contact", name: "Carol", you: true });
    },
    CASE_MS,
  );
});

describe("the census, measured raw under the contact's own principal", () => {
  const asCarol = <T,>(fn: (tx: TenantDb) => Promise<T>) =>
    withTenant(f.tenantId, { type: "contact", id: carol, clientId: acme }, fn);

  it(
    "a contact can neither rewrite nor delete their own comment",
    async () => {
      const t = await newTask("Census");
      const text = `My words ${run}`;
      const c = await createPortalComment(principal(carol), t.id, text);
      // Readable under her principal — so a refusal below is the deny, not invisibility.
      expect(await asCarol((tx) => tx.comment.count({ where: { id: c.id } }))).toBe(1);

      // `portal_no_update` is a WITH CHECK deny: 42501, loudly.
      await expect(
        asCarol((tx) => tx.comment.updateMany({ where: { id: c.id }, data: { bodyText: `Rewritten ${run}` } })),
      ).rejects.toThrow(/row-level security/);
      await expect(
        asCarol((tx) => tx.comment.updateMany({ where: { id: c.id }, data: { deletedAt: new Date() } })),
      ).rejects.toThrow(/row-level security/);
      // `portal_no_delete` is a USING deny: zero rows, silently — so what
      // is measured is that the row is still there.
      const deleted = await asCarol((tx) => tx.comment.deleteMany({ where: { id: c.id } }));
      expect(deleted.count).toBe(0);

      const row = await f.platform.comment.findUniqueOrThrow({
        where: { id: c.id },
        select: { bodyText: true, deletedAt: true, editedAt: true },
      });
      expect(row).toEqual({ bodyText: text, deletedAt: null, editedAt: null });
    },
    CASE_MS,
  );

  it(
    "a contact may insert only a CLIENT_VISIBLE comment signed by themself",
    async () => {
      const t = await newTask("Census insert");
      const row = (over: { authorContactId: string; visibility: "INTERNAL" | "CLIENT_VISIBLE" }) => ({
        tenantId: f.tenantId,
        subjectType: "WORK_ITEM" as const,
        subjectId: t.id,
        body: doc(`Raw ${run}`),
        bodyText: `Raw ${run}`,
        ...over,
      });
      // Signed as a colleague: refused.
      await expect(
        asCarol((tx) => tx.comment.create({ data: row({ authorContactId: dan, visibility: "CLIENT_VISIBLE" }), select: { id: true } })),
      ).rejects.toThrow(/row-level security/);
      // An internal note from a contact: refused.
      await expect(
        asCarol((tx) => tx.comment.create({ data: row({ authorContactId: carol, visibility: "INTERNAL" }), select: { id: true } })),
      ).rejects.toThrow(/row-level security/);
      expect(await f.platform.comment.count({ where: { tenantId: f.tenantId, subjectId: t.id } })).toBe(0);
      // THE POSITIVE CONTROL: the one row the census admits, raw.
      const ok = await asCarol((tx) =>
        tx.comment.create({ data: row({ authorContactId: carol, visibility: "CLIENT_VISIBLE" }), select: { id: true } }),
      );
      expect(await f.platform.comment.count({ where: { tenantId: f.tenantId, subjectId: t.id } })).toBe(1);
      expect(ok.id).toBeTruthy();
    },
    CASE_MS,
  );
});

// ═══════════════════════════════════════════════════════════════════════
// "YOUR AGENCY REPLIED" (Phase 3 slice 76, founder decision C45)
// ═══════════════════════════════════════════════════════════════════════

describe("your agency replied (listPortalAgencyReplies, C45)", () => {
  /** The row the reader's card would list for one task — the list is client-wide, and other cases leave rows too. */
  const rowFor = async (contactId: string, taskId: string, opts?: { projectId?: string; clientId?: string }) =>
    (
      await listPortalAgencyReplies(
        principal(contactId, opts?.clientId ?? acme),
        opts?.projectId ? { projectId: opts.projectId } : undefined,
      )
    ).find((r) => r.taskId === taskId);

  const agencySays = async (taskId: string, text: string, visibility: "INTERNAL" | "CLIENT_VISIBLE" = "CLIENT_VISIBLE") =>
    (await createComment(ownerCtx(), taskId, { doc: doc(text), visibility })).id;

  it(
    "an agency comment that is the task's newest raises it — for every contact of the client — and the client's answer clears it",
    async () => {
      const t = await newTask("Replied to");
      const replyId = await agencySays(t.id, `Here is the draft ${run}`);
      const written = await f.platform.comment.findUniqueOrThrow({ where: { id: replyId }, select: { createdAt: true } });

      const row = await rowFor(carol, t.id);
      expect(row).toBeDefined();
      // The exact shape: what the card needs, and nothing that names who.
      expect(Object.keys(row!).sort()).toEqual(["project", "repliedAt", "taskId", "title"]);
      expect(Object.keys(row!.project).sort()).toEqual(["key", "name"]);
      expect(row!.title).toBe(`Replied to ${run}`);
      expect(row!.project).toEqual({ key: projectKey, name: projectName });
      expect(row!.repliedAt.getTime()).toBe(written.createdAt.getTime());
      // Per CLIENT, not per person: a colleague sees it too (C45 chose no "seen" record).
      expect(await rowFor(dan, t.id)).toBeDefined();
      // The member who wrote it is nowhere in the answer.
      const member = await f.platform.member.findUniqueOrThrow({
        where: { id: f.seats.owner.memberId },
        select: { id: true, userId: true, user: { select: { name: true, email: true } } },
      });
      const json = JSON.stringify(await listPortalAgencyReplies(principal(carol)));
      for (const secret of [member.id, member.userId, member.user.email]) expect(json).not.toContain(secret);
      if (member.user.name) expect(json).not.toContain(member.user.name);

      // Somebody at the client answers — the ball is back with the agency, for everyone at the client.
      await createPortalComment(principal(gil), t.id, `Thanks ${run}`);
      expect(await rowFor(carol, t.id)).toBeUndefined();
      expect(await rowFor(dan, t.id)).toBeUndefined();

      // And the agency speaking again raises it again.
      await agencySays(t.id, `One more thing ${run}`);
      expect(await rowFor(carol, t.id)).toBeDefined();
    },
    CASE_MS,
  );

  it(
    "an INTERNAL note neither raises it nor clears it; a deleted reply does not count",
    async () => {
      // Client last, then an internal note: nothing is waiting on the client.
      const quiet = await newTask("Client last");
      await agencySays(quiet.id, `Question ${run}`);
      await createPortalComment(principal(gil), quiet.id, `Answer ${run}`);
      await agencySays(quiet.id, `Internal musing ${run}`, "INTERNAL");
      expect(await rowFor(carol, quiet.id)).toBeUndefined();

      // Agency last, then an internal note: still waiting on the client.
      const loud = await newTask("Agency last");
      await agencySays(loud.id, `Please confirm ${run}`);
      await agencySays(loud.id, `Internal follow-up ${run}`, "INTERNAL");
      expect(await rowFor(carol, loud.id)).toBeDefined();

      // A reply the agency deleted leaves the client's word the newest.
      const undone = await newTask("Reply deleted");
      await createPortalComment(principal(gil), undone.id, `Opening question ${run}`);
      const oops = await agencySays(undone.id, `Wrong task ${run}`);
      expect(await rowFor(carol, undone.id)).toBeDefined();
      await deleteComment(ownerCtx(), oops);
      expect(await rowFor(carol, undone.id)).toBeUndefined();
    },
    CASE_MS,
  );

  it(
    "a reply older than the window no longer stands",
    async () => {
      const t = await newTask("Old reply");
      const id = await agencySays(t.id, `Long ago ${run}`);
      expect(await rowFor(carol, t.id)).toBeDefined();
      // Planted past the window — the one way to age a row.
      await f.platform.comment.update({
        where: { id },
        data: { createdAt: new Date(Date.now() - (PORTAL_REPLY_WINDOW_DAYS + 1) * 86_400_000) },
        select: { id: true },
      });
      expect(await rowFor(carol, t.id)).toBeUndefined();
    },
    CASE_MS,
  );

  it(
    "only tasks the portal shows: never another client's, an archived task, a switched-off project's or a task made private",
    async () => {
      const betaTask = await newTask("Beta's", { projectId: pBeta });
      await agencySays(betaTask.id, `To Beta ${run}`);
      expect(await rowFor(carol, betaTask.id)).toBeUndefined();
      expect(await rowFor(bo, betaTask.id, { clientId: beta })).toBeDefined();

      const archived = await newTask("Archived after the reply");
      await agencySays(archived.id, `Before archiving ${run}`);
      await setItemArchived(ownerCtx(), archived.id, true);
      expect(await rowFor(carol, archived.id)).toBeUndefined();

      const off = await newTask("Portal off", { projectId: pOff });
      await agencySays(off.id, `Behind the switch ${run}`);
      expect(await rowFor(carol, off.id)).toBeUndefined();

      const privateNow = await newTask("Made private");
      await agencySays(privateNow.id, `Shared, then not ${run}`);
      expect(await rowFor(carol, privateNow.id)).toBeDefined();
      await makeItemPrivate(ownerCtx(), privateNow.id);
      expect(await rowFor(carol, privateNow.id)).toBeUndefined();
    },
    CASE_MS,
  );

  it(
    "narrowed to one project for the project page; a project that is not the reader's is refused",
    async () => {
      const pExtra = randomUUID();
      await f.platform.project.create({
        data: {
          id: pExtra,
          tenantId: f.tenantId,
          clientId: acme,
          key: `PCX${run.slice(0, 3).toUpperCase()}`,
          name: `Extra ${run}`,
          portalEnabled: true,
        },
        select: { id: true },
      });
      const here = await newTask("Here");
      const there = await newTask("There", { projectId: pExtra });
      await agencySays(here.id, `Here ${run}`);
      await agencySays(there.id, `There ${run}`);

      const narrowed = await listPortalAgencyReplies(principal(carol), { projectId: pOn });
      expect(narrowed.some((r) => r.taskId === here.id)).toBe(true);
      expect(narrowed.some((r) => r.taskId === there.id)).toBe(false);
      expect(narrowed.every((r) => r.project.key === projectKey)).toBe(true);
      expect(await rowFor(carol, there.id)).toBeDefined();

      expect(await authzReason(listPortalAgencyReplies(principal(carol), { projectId: pBeta }))).toBe("NOT_FOUND");
      expect(await authzReason(listPortalAgencyReplies(principal(carol), { projectId: pOff }))).toBe("NOT_FOUND");
      await expect(listPortalAgencyReplies(principal(sue))).rejects.toBeInstanceOf(AuthzError);
    },
    CASE_MS,
  );
});
