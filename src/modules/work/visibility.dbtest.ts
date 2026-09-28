import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { listPortalPendingDeliverables } from "@/documents/portal";
import { listDocuments, requestDocumentSignoff } from "@/documents/service";
import { DomainError } from "@/lib/domain-error";
import { actorFor, maskIds, setupTenant } from "@/members/dbtest-fixture";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";

import {
  assignItemToContact,
  bulkSetPriority,
  bulkShare,
  changeItemVisibility,
  createComment,
  createItem,
  deleteComment,
  deleteItem,
  makeItemPrivate,
  makePrivateWithChildren,
  previewMakePrivate,
  setItemArchived,
  type MakePrivateResult,
} from "./index";
import { setPortalTaskDone } from "./portal-writes";
import { lockProjectRanks } from "./rank-lock";

/**
 * THE SHARING UI's SERVER HALF AGAINST THE REAL SCHEMA (Phase 3
 * slice 72; founder decisions C35–C37): `previewMakePrivate`,
 * `makePrivateWithChildren`, `makeItemPrivate` and `bulkShare`
 * (visibility.ts), and "a client's own comments follow their task"
 * (follow-task.ts), against the real `app_runtime` role, the real
 * triggers and a real contact principal.
 *
 * WHAT ONLY A DATABASE CAN SAY, and therefore why this file exists:
 *
 *  · THE LEVER IS MEASURED FROM THE CLIENT'S SIDE. Before the cascade a
 *    raw read under the contact principal returns every row of the
 *    closure by id, with no visibility filter of ours; after it, the
 *    same read returns none. `portal_gate` is what answers — the
 *    service's own counts are checked separately and are not the proof.
 *  · THE COUNTS ARE EXACT. Archived rows count (the downgrade trigger
 *    counts them), soft-deleted rows do not (it ignores them), and an
 *    INTERNAL row is neither counted nor touched.
 *  · THE SCOPE GATE IS OBSERVABLE. Every seeded template that holds
 *    `work_item:change_visibility` also holds `client:view_all`, so with
 *    seeded seats a scope FILTER can never refuse anything. The custom
 *    "Visibility only" seat below holds exactly two codes and one
 *    client, which is the only shape in which the filter can be seen.
 *  · C37's NEGATIVE CONTROLS — the worst-bug guard. A re-share raises
 *    the client's OWN comments and nothing else: not a member's
 *    comment the cascade lowered, not a deleted one, not one on a file,
 *    not a subtask, and never one attributed to a contact of ANOTHER
 *    client. Each has its own row, on all three raise paths.
 *  · THE REVERSE RACES. A writer that hangs a new client-visible child
 *    under the task while the cascade waits (a comment, a contact's
 *    comment, an attachment's raise) is lowered with the rest — the
 *    cascade is SEEN waiting on that writer's transaction id before the
 *    writer is released, so an implementation that did not wait fails.
 *
 * Tenant slugs come from `setupTenant("vshare")`, and the prefix
 * `vshare-` is registered in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts)
 * so `sweep-dbtests` can collect this suite's orphans. `e2e-` is the
 * BROWSER harness's prefix and is swept by AGE — a dbtest using it would
 * have its fixtures deleted mid-run by a concurrent e2e run.
 */

const run = randomUUID().slice(0, 8);
/** Every title and every comment's words carry this token, so an audit scan can look for it. */
const TOKEN = `vshare${run}words`;
const W = (label: string) => `${label} ${TOKEN}`;

/** A heavy case's wall clock over the transatlantic link (DB_TX_TIMEOUT_MS widens the budgets 4×). */
const LONG = 240_000;

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
/** The fixture client: portal on, one ACTIVE primary contact. */
let acme: string;
/** The OTHER client — the foreign project, and the contact whose words must never be published to acme. */
let beta: string;
let pOn: string;
/** A second project of acme — the two-project selection. */
let pOther: string;
/** Beta's project — outside the custom seat's scope. */
let pBeta: string;
/** Carol — ACTIVE, CONTACT_PRIMARY, of acme. */
let carol: string;
/** Bo — ACTIVE, of beta. */
let bo: string;
/**
 * THE SEAT THAT MAKES THE SCOPE GATE OBSERVABLE — `work_item:view` and
 * `work_item:change_visibility`, nothing else (no `work_item:edit`, no
 * `client:view_all`), scoped by `memberClient` to acme alone.
 */
let visOnly: { memberId: string; roleId: string; actor: MemberActor };
/** The custom seat's `user` row — setupTenant's cleanup collects only its own four. */
const extraUserIds: string[] = [];

type Principal = Parameters<typeof withTenant>[1];
const member = (): Principal => ({ type: "member", id: f.seats.owner.memberId });
const contactOf = (id: string): Principal => ({ type: "contact", id, clientId: acme });

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const ctxOf = (actor: MemberActor) => ({ tenantId: f.tenantId, actor });

const principal = (contactId = carol): PortalPrincipal => ({ contactId, tenantId: f.tenantId, clientId: acme, gates });

const doc = (words: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: words }] }] });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ── Items ─────────────────────────────────────────────────────────────

/** A live task through the real service — INTERNAL at the root, the parent's visibility below it. */
async function task(title: string, opts: { parentId?: string; projectId?: string } = {}): Promise<string> {
  const { id } = await createItem(ownerCtx(), {
    projectId: opts.projectId ?? pOn,
    title: W(title),
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
  });
  return id;
}

/** A root task already shared with the client. */
async function sharedTask(title: string, projectId = pOn): Promise<string> {
  const id = await task(title, { projectId });
  await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
  return id;
}

/** An EPIC root. `createItem` never makes one — ordering.dbtest.ts's way: create, then retype. */
async function epic(title: string): Promise<string> {
  const id = await task(title);
  await f.platform.workItem.update({ where: { id }, data: { type: "EPIC" }, select: { id: true } });
  return id;
}

/** The row as the platform sees it — INLINE select, never the 512 KB description. */
const itemRow = (id: string) =>
  f.platform.workItem.findUniqueOrThrow({
    where: { id },
    select: {
      visibility: true,
      deletedAt: true,
      archivedAt: true,
      assigneeContactId: true,
      contactCompletedAt: true,
    },
  });
const visOf = async (id: string) => (await itemRow(id)).visibility;
const commentVisOf = async (id: string) =>
  (await f.platform.comment.findUniqueOrThrow({ where: { id }, select: { visibility: true } })).visibility;
const docVisOf = async (id: string) =>
  (await f.platform.document.findUniqueOrThrow({ where: { id }, select: { visibility: true } })).visibility;

// ── Comments ──────────────────────────────────────────────────────────

/** A member's comment through the real service. */
const memberComment = async (itemId: string, visibility: "INTERNAL" | "CLIENT_VISIBLE", words: string) =>
  (await createComment(ownerCtx(), itemId, { doc: doc(W(words)), visibility })).id;

/**
 * A contact's comment through THE CENSUS — an INSERT under the contact
 * principal, which is how a client's words are born (comments.dbtest.ts'
 * shape): CLIENT_VISIBLE, authored by the principal itself.
 */
const contactComment = async (
  subjectType: "WORK_ITEM" | "DOCUMENT",
  subjectId: string,
  words: string,
  contactId = carol,
) =>
  (
    await withTenant(f.tenantId, contactOf(contactId), (tx) =>
      tx.comment.create({
        data: {
          tenantId: f.tenantId,
          subjectType,
          subjectId,
          authorContactId: contactId,
          body: doc(W(words)),
          bodyText: W(words),
          visibility: "CLIENT_VISIBLE",
        },
        select: { id: true },
      }),
    )
  ).id;

/** A comment planted directly through the platform client (BYPASSRLS) — for shapes no service makes. */
const rawComment = async (input: {
  subjectType: "WORK_ITEM" | "DOCUMENT" | "FILE_VERSION";
  subjectId: string;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  words: string;
  authorContactId?: string;
}) =>
  (
    await f.platform.comment.create({
      data: {
        tenantId: f.tenantId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        authorMemberId: input.authorContactId ? null : f.seats.owner.memberId,
        authorContactId: input.authorContactId ?? null,
        body: doc(W(input.words)),
        bodyText: W(input.words),
        visibility: input.visibility,
      },
      select: { id: true },
    })
  ).id;

// ── Files ─────────────────────────────────────────────────────────────

/**
 * A file ATTACHED to a work item, with one COMMITTED version — planted
 * through the platform client (documents/portal.dbtest.ts' shape), so no
 * storage transport is needed. `document_anchor_guard` still runs and
 * still insists on the item's client and project, and on a
 * client-visible item for a client-visible file.
 */
async function plantFile(
  itemId: string,
  opts: { visibility: "INTERNAL" | "CLIENT_VISIBLE"; kind?: "GENERAL" | "DELIVERABLE"; name: string },
): Promise<{ documentId: string; versionId: string }> {
  const item = await f.platform.workItem.findUniqueOrThrow({
    where: { id: itemId },
    select: { clientId: true, projectId: true },
  });
  const objectId = randomUUID();
  await f.platform.fileObject.create({
    data: {
      id: objectId,
      tenantId: f.tenantId,
      r2Key: `${f.tenantId}/${objectId}`,
      sha256: sha(objectId),
      sizeBytes: BigInt(7),
      contentType: "text/plain",
      status: "COMMITTED",
      committedAt: new Date(),
    },
  });
  const documentId = randomUUID();
  const versionId = randomUUID();
  await f.platform.document.create({
    data: {
      id: documentId,
      tenantId: f.tenantId,
      clientId: item.clientId,
      projectId: item.projectId,
      name: W(opts.name),
      kind: opts.kind ?? "GENERAL",
      visibility: opts.visibility,
      attachedToType: "WORK_ITEM",
      attachedToId: itemId,
      versions: { create: { id: versionId, versionNumber: 1, fileObjectId: objectId } },
    },
  });
  return { documentId, versionId };
}

// ── The trail ─────────────────────────────────────────────────────────

/** The audit ids that exist now — `auditsSince` returns exactly what a call wrote after this. */
const auditIds = async () =>
  new Set(
    (await f.platform.auditEvent.findMany({ where: { tenantId: f.tenantId }, select: { id: true } })).map((r) => r.id),
  );
const auditsSince = async (before: ReadonlySet<string>) =>
  (
    await f.platform.auditEvent.findMany({
      where: { tenantId: f.tenantId },
      orderBy: { id: "asc" },
      select: { id: true, action: true, targetType: true, targetId: true, metadata: true },
    })
  ).filter((r) => !before.has(r.id));

const activityIds = async () =>
  new Set(
    (await f.platform.workItemActivity.findMany({ where: { tenantId: f.tenantId }, select: { id: true } })).map(
      (r) => r.id,
    ),
  );
const activitySince = async (before: ReadonlySet<string>) =>
  (
    await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        workItemId: true,
        field: true,
        oldValue: true,
        newValue: true,
        oldRef: true,
        newRef: true,
        commentId: true,
        visibility: true,
      },
    })
  ).filter((r) => !before.has(r.id));

/** A refusal as one comparable string — `authz:NOT_FOUND`, `domain:INVALID_INPUT` — or `resolved`. */
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof AuthzError) return `authz:${e.reason}`;
    if (e instanceof DomainError) return `domain:${e.code}`;
    throw e;
  }
};

// ── Lock races (work.dbtest.ts' xid-scoped probe, copied: that file is not ours to edit) ──

/**
 * A colleague's transaction: runs `body` under `who`, reports its own
 * transaction id, and stays open until released — so a writer can be
 * made to wait on THIS transaction and be seen doing so.
 */
function holdOpen<T>(who: Principal, body: (tx: TenantDb) => Promise<T>, timeoutMs = 30_000) {
  let ready!: (held: { result: T; xid: string }) => void;
  let release!: () => void;
  const signalled = new Promise<{ result: T; xid: string }>((r) => (ready = r));
  const released = new Promise<void>((r) => (release = r));
  const done = withTenant(
    f.tenantId,
    who,
    async (tx) => {
      const result = await body(tx);
      // pg_locks shows the 32-bit xid; txid_current() carries the epoch above it.
      const rows = await tx.$queryRaw<{ xid: string }[]>`SELECT (txid_current() % 4294967296)::text AS xid`;
      const xid = rows[0]?.xid;
      if (!xid) throw new Error("the colleague's transaction reported no id");
      ready({ result, xid });
      await released;
    },
    { timeoutMs },
  );
  const isReady = Promise.race([
    signalled,
    done.then((): never => {
      throw new Error("the colleague committed without signalling");
    }),
  ]);
  return { isReady, release, done };
}

/** Resolves once a transaction is blocked on the colleague's own transaction id; throws if none ever is. */
async function waitForWaiterOn(xid: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await f.platform.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks
       WHERE NOT granted AND locktype = 'transactionid' AND transactionid::text = ${xid}`;
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("nothing ever waited on the colleague's transaction — the race was not exercised");
}

/**
 * The race: the colleague's `body` runs and holds its locks; `writer`
 * is started and must be SEEN waiting on the colleague's transaction
 * before the colleague is released and commits. Returns the colleague's
 * result and the writer's promise, still pending, for the test to await.
 */
async function raceBehind<T, R>(
  who: Principal,
  body: (tx: TenantDb) => Promise<T>,
  writer: () => Promise<R>,
): Promise<{ held: T; result: Promise<R> }> {
  const colleague = holdOpen(who, body);
  try {
    const { result: held, xid } = await colleague.isReady;
    const result = writer();
    result.catch(() => undefined); // awaited by the test — never an unhandled rejection meanwhile
    await Promise.race([
      waitForWaiterOn(xid),
      result.then(
        () => {
          throw new Error("the writer finished without waiting on the colleague — the race was not exercised");
        },
        (e: unknown) => {
          throw e;
        },
      ),
    ]);
    return { held, result };
  } finally {
    colleague.release();
    await colleague.done;
  }
}

// ── Fixture ───────────────────────────────────────────────────────────

beforeAll(async () => {
  f = await setupTenant("vshare");
  gates = await resolvePortalModuleGates(f.tenantId);
  acme = randomUUID();
  beta = randomUUID();
  pOn = randomUUID();
  pOther = randomUUID();
  pBeta = randomUUID();
  carol = randomUUID();
  bo = randomUUID();

  const up = run.slice(0, 3).toUpperCase();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: pOn, tenantId: f.tenantId, clientId: acme, key: `VSA${up}`, name: `Site ${run}`, portalEnabled: true },
      { id: pOther, tenantId: f.tenantId, clientId: acme, key: `VSB${up}`, name: `Shop ${run}`, portalEnabled: true },
      { id: pBeta, tenantId: f.tenantId, clientId: beta, key: `VSC${up}`, name: `Beta ${run}`, portalEnabled: true },
    ],
  });
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  await f.platform.contact.createMany({
    data: [
      { id: carol, tenantId: f.tenantId, clientId: acme, name: "Carol", email: `vshare-carol-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: bo, tenantId: f.tenantId, clientId: beta, name: "Bo", email: `vshare-bo-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
    ],
  });

  // ── The "Visibility only" seat ────────────────────────────────────
  //
  // THE CATALOGUE MUST BE SEEDED for this to mean anything: with no
  // `permission` rows a custom role holds nothing, and every refusal
  // below would pass by refusing everybody (contact-tasks.dbtest.ts).
  const userId = randomUUID();
  const email = `vshare-visonly-${run}@test.invalid`;
  await f.platform.user.create({ data: { id: userId, name: email, email } });
  // Recorded the moment it exists: a `user` is platform-level, and an
  // orphan is one `sweep-dbtests` cannot reach by tenant.
  extraUserIds.push(userId);
  const seat = await f.platform.member.create({ data: { tenantId: f.tenantId, userId } });
  const role = await f.platform.role.create({ data: { tenantId: f.tenantId, name: `Visibility only ${run}` } });
  const codes = ["work_item:change_visibility", "work_item:view"];
  const perms = await f.platform.permission.findMany({ where: { code: { in: codes } } });
  expect(perms.map((p) => p.code).sort()).toEqual(codes);
  await f.platform.rolePermission.createMany({
    data: perms.map((p) => ({ tenantId: f.tenantId, roleId: role.id, permissionId: p.id })),
  });
  await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: seat.id, roleId: role.id } });
  // DIRECT client scope, never a project: a `MemberProject` row is a
  // notification audience (contact-tasks.dbtest.ts' lesson).
  await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: seat.id, clientId: acme } });
  visOnly = { memberId: seat.id, roleId: role.id, actor: actorFor(seat.id) };
  // The EMPLOYEE seat IN scope: it holds `work_item:edit` (C M A E) and
  // not `work_item:change_visibility` (C M A), so on an in-scope id the
  // permission is the only thing that can refuse it.
  await f.platform.memberClient.create({
    data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: acme },
  });
}, LONG);

afterAll(async () => {
  if (!f?.tenantId) return;
  const db = f.platform;
  const tenantId = f.tenantId;
  await db.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId}`;
  await db.notification.deleteMany({ where: { tenantId } });
  await db.emailOutbox.deleteMany({ where: { tenantId } });
  await db.comment.deleteMany({ where: { tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId } });
  await db.fileVersion.deleteMany({ where: { tenantId } });
  await db.document.deleteMany({ where: { tenantId } });
  await db.fileObject.deleteMany({ where: { tenantId } });
  // Children before parents: `work_item.parent_id` is ON DELETE RESTRICT.
  await db.workItem.deleteMany({ where: { tenantId, depth: 2 } });
  await db.workItem.deleteMany({ where: { tenantId, depth: 1 } });
  await db.workItem.deleteMany({ where: { tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId } });
  // `nextCounter` mints a `tenant_counter` row per project, RESTRICT to `tenant`.
  await db.tenantCounter.deleteMany({ where: { tenantId } });
  await db.memberProject.deleteMany({ where: { tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId } });
  await db.contact.deleteMany({ where: { tenantId } });
  await db.project.deleteMany({ where: { tenantId } });
  await db.client.deleteMany({ where: { tenantId } });
  await db.tenantPreference.deleteMany({ where: { tenantId } });
  await f.cleanup();
  // AFTER `cleanup()`: `member` has a foreign key to `user`, and it is
  // `cleanup()` that deletes this tenant's members.
  await f.platform.user.deleteMany({ where: { id: { in: extraUserIds } } });
}, LONG);

// ═══════════════════════════════════════════════════════════════════════

/**
 * ONE EPIC, ITS WHOLE SUBTREE, AND EVERYTHING HUNG ON IT:
 *
 *   E  EPIC, shared ─┬─ T1 shared ── S1 shared SUBTASK, handed to Carol, ticked
 *                    ├─ T2 shared, ARCHIVED
 *                    ├─ T3 INTERNAL
 *                    └─ T4 shared, then SOFT-DELETED
 *
 *   comments: cE  (member, shared, on E)       kE (Carol's, on E — the census)
 *             cS1 (member, shared, on S1)      nT1 (member, INTERNAL note on T1)
 *             cDoc (shared, on file F)          cFv (shared, on F's version 1)
 *   file:     F — shared DELIVERABLE on T1, committed version, sign-off PENDING
 */
describe("make private with children: an epic's subtree, measured from both planes", () => {
  const fx = {} as {
    E: string;
    T1: string;
    T2: string;
    T3: string;
    T4: string;
    S1: string;
    cE: string;
    kE: string;
    cS1: string;
    nT1: string;
    F: string;
    fv: string;
    cDoc: string;
    cFv: string;
    handover: string;
  };
  let result: MakePrivateResult | null = null;
  let auditsBefore = new Set<string>();
  let activityBefore = new Set<string>();

  beforeAll(async () => {
    fx.E = await epic("Relaunch");
    // T3 is born while E is still private, so it inherits INTERNAL.
    fx.T3 = await task("Internal estimate", { parentId: fx.E });
    await changeItemVisibility(ownerCtx(), fx.E, "CLIENT_VISIBLE");
    fx.T1 = await task("Design", { parentId: fx.E });
    fx.T2 = await task("Old copy", { parentId: fx.E });
    fx.T4 = await task("Dropped idea", { parentId: fx.E });
    fx.S1 = await task("Send us the logo", { parentId: fx.T1 });
    await setItemArchived(ownerCtx(), fx.T2, true);
    await deleteItem(ownerCtx(), fx.T4);
    await assignItemToContact(ownerCtx(), fx.S1, carol);
    await setPortalTaskDone(principal(), fx.S1, true);

    fx.cE = await memberComment(fx.E, "CLIENT_VISIBLE", "Kickoff notes");
    fx.cS1 = await memberComment(fx.S1, "CLIENT_VISIBLE", "Any format is fine");
    fx.nT1 = await memberComment(fx.T1, "INTERNAL", "Margin is thin");
    fx.kE = await contactComment("WORK_ITEM", fx.E, "Looking forward to it");

    const file = await plantFile(fx.T1, { visibility: "CLIENT_VISIBLE", kind: "DELIVERABLE", name: "mockups.txt" });
    fx.F = file.documentId;
    fx.fv = file.versionId;
    await requestDocumentSignoff(ownerCtx(), fx.F);
    fx.cDoc = await rawComment({ subjectType: "DOCUMENT", subjectId: fx.F, visibility: "CLIENT_VISIBLE", words: "On the file" });
    fx.cFv = await rawComment({ subjectType: "FILE_VERSION", subjectId: fx.fv, visibility: "CLIENT_VISIBLE", words: "On version one" });

    // The fixture's own facts, asserted so a wrong fixture fails HERE
    // rather than as a mysterious count below.
    expect(await visOf(fx.T1)).toBe("CLIENT_VISIBLE");
    expect(await visOf(fx.S1)).toBe("CLIENT_VISIBLE");
    expect(await visOf(fx.T3)).toBe("INTERNAL");
    expect(await itemRow(fx.T2)).toMatchObject({ visibility: "CLIENT_VISIBLE", archivedAt: expect.any(Date) });
    expect(await itemRow(fx.T4)).toMatchObject({ visibility: "CLIENT_VISIBLE", deletedAt: expect.any(Date) });
    expect(await itemRow(fx.S1)).toMatchObject({ assigneeContactId: carol, contactCompletedAt: expect.any(Date) });
    const handover = await f.platform.workItemActivity.findFirstOrThrow({
      where: { tenantId: f.tenantId, workItemId: fx.S1, field: "assigneeContactId" },
      select: { id: true, visibility: true },
    });
    // The hand-over's history row is on the portal-safe list: the client reads it.
    expect(handover.visibility).toBe("CLIENT_VISIBLE");
    fx.handover = handover.id;
    expect(
      (await f.platform.document.findUniqueOrThrow({ where: { id: fx.F }, select: { approvalStatus: true } }))
        .approvalStatus,
    ).toBe("PENDING");
  }, LONG);

  it("the preview counts exactly: archived included, soft-deleted and private excluded, the client's own words and the files' threads in", async () => {
    // Recomputed from the fixture above, never from the service:
    //   below    = T1, T2 (archived), S1                    — not T3 (INTERNAL), not T4 (deleted)
    //   comments = cE, kE (on E), cS1, cDoc, cFv             — not nT1 (INTERNAL)
    //   files    = F;  handedOver = S1;  awaitingSignoff = F
    expect(await previewMakePrivate(ownerCtx(), [fx.E])).toEqual({
      portalEnabled: true,
      tasks: 1,
      alreadyPrivate: 0,
      below: 3,
      comments: 5,
      files: 1,
      handedOver: 1,
      awaitingSignoff: 1,
    });
  });

  it("before the cascade a contact reads every row of the closure; after it, none — and the sign-off is hidden, not withdrawn", async () => {
    const closure = [fx.E, fx.T1, fx.T2, fx.S1];
    const sharedComments = [fx.cE, fx.kE, fx.cS1, fx.cDoc, fx.cFv];
    // A raw read under Carol's own principal, by id, with NO visibility
    // term of ours: whatever comes back is what `portal_gate` admits.
    // Reads in sequence on the one transaction (AGENTS.md).
    const read = () =>
      withTenant(f.tenantId, contactOf(carol), async (tx) => {
        const items = await tx.workItem.findMany({ where: { id: { in: closure } }, select: { id: true } });
        const comments = await tx.comment.findMany({
          where: { id: { in: [...sharedComments, fx.nT1] } },
          select: { id: true },
        });
        const documents = await tx.document.findMany({ where: { id: fx.F }, select: { id: true } });
        const activity = await tx.workItemActivity.findMany({
          where: { workItemId: { in: closure } },
          select: { id: true },
        });
        return {
          items: items.map((r) => r.id).sort(),
          comments: comments.map((r) => r.id).sort(),
          documents: documents.map((r) => r.id),
          activity: activity.map((r) => r.id),
        };
      });

    const before = await read();
    expect(before.items).toEqual([...closure].sort());
    // The INTERNAL note is already absent — the gate, not the cascade.
    expect(before.comments).toEqual([...sharedComments].sort());
    expect(before.documents).toEqual([fx.F]);
    expect(before.activity).toContain(fx.handover);
    expect((await listPortalPendingDeliverables(principal())).map((d) => d.id)).toContain(fx.F);

    auditsBefore = await auditIds();
    activityBefore = await activityIds();
    result = await makePrivateWithChildren(ownerCtx(), [fx.E]);
    expect(result).toEqual({
      tasks: 1,
      alreadyPrivate: 0,
      below: 3,
      comments: 5,
      files: 1,
      endedContactAssignments: 1,
    });

    // THE LEVER, FROM THE CLIENT'S SIDE: the same raw read returns nothing.
    expect(await read()).toEqual({ items: [], comments: [], documents: [], activity: [] });
    expect((await listPortalPendingDeliverables(principal())).map((d) => d.id)).not.toContain(fx.F);
    // HIDDEN, NOT WITHDRAWN — the ask outlives the file's visibility,
    // exactly as a single file's make-private has always left it.
    expect(
      await f.platform.document.findUniqueOrThrow({
        where: { id: fx.F },
        select: { visibility: true, approvalStatus: true },
      }),
    ).toEqual({ visibility: "INTERNAL", approvalStatus: "PENDING" });
  }, LONG);

  it("writes the rows, the history and the audit trail it claims — and nothing for what it skipped", async () => {
    expect(result, "the cascade above must have run").not.toBeNull();
    for (const id of [fx.E, fx.T1, fx.T2, fx.S1]) expect(await visOf(id), id).toBe("INTERNAL");
    expect(await visOf(fx.T3)).toBe("INTERNAL");
    // Soft-deleted: neither counted nor flipped (the restore guard keeps it dead).
    expect(await itemRow(fx.T4)).toMatchObject({ visibility: "CLIENT_VISIBLE", deletedAt: expect.any(Date) });
    // The hand-over ended in the same statement, claim and all (the CHECK insists).
    expect(await itemRow(fx.S1)).toMatchObject({ assigneeContactId: null, contactCompletedAt: null });
    for (const c of [fx.cE, fx.kE, fx.cS1, fx.cDoc, fx.cFv, fx.nT1]) expect(await commentVisOf(c), c).toBe("INTERNAL");

    // ── History ──
    const history = await activitySince(activityBefore);
    // Nothing for the rows it skipped.
    expect(history.filter((h) => h.workItemId === fx.T3 || h.workItemId === fx.T4)).toEqual([]);
    const s1 = history.filter((h) => h.workItemId === fx.S1);
    const ended = s1.findIndex((h) => h.field === "assigneeContactId");
    const flipped = s1.findIndex((h) => h.field === "visibility");
    expect(ended, "the ended hand-over has a history row").toBeGreaterThanOrEqual(0);
    expect(flipped).toBeGreaterThanOrEqual(0);
    // The ended hand-over FIRST, then the visibility row — the order the panel reads them in.
    expect(ended).toBeLessThan(flipped);
    expect(s1[ended]).toMatchObject({ oldRef: carol, newRef: null, visibility: "INTERNAL" });
    // Every history row of every closure item is behind the gate now —
    // the new ones, and the old hand-over row the downgrade trigger lowered.
    const all = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: { in: [fx.E, fx.T1, fx.T2, fx.S1] } },
      select: { visibility: true },
    });
    expect(all.every((a) => a.visibility === "INTERNAL")).toBe(true);
    // One visibility row per flipped task, no more.
    expect(
      history
        .filter((h) => h.field === "visibility")
        .map((h) => h.workItemId)
        .sort(),
    ).toEqual([fx.E, fx.T1, fx.T2, fx.S1].sort());

    // ── The audit trail ──
    const trail = await auditsSince(auditsBefore);
    const bulk = trail.filter((a) => a.action === "work_item.bulk_edited");
    expect(bulk).toHaveLength(1);
    expect(bulk[0]!.metadata).toEqual({
      projectId: pOn,
      reason: "make_private",
      tasks: 1,
      below: 3,
      comments: 5,
      files: 1,
      endedContactAssignments: 1,
    });

    const items = trail.filter((a) => a.action === "work_item.visibility_changed");
    expect(items.map((a) => a.targetId).sort()).toEqual([fx.E, fx.T1, fx.T2, fx.S1].sort());
    const base = { from: "CLIENT_VISIBLE", to: "INTERNAL", projectId: pOn, via: "cascade" };
    for (const a of items) {
      expect(a.metadata, a.targetId ?? "").toEqual(
        a.targetId === fx.S1 ? { ...base, endedContactAssignment: true } : base,
      );
    }

    const comments = trail.filter((a) => a.action === "comment.visibility_changed");
    const byComment = new Map(comments.map((a) => [a.targetId, a.metadata]));
    expect(comments).toHaveLength(5);
    expect(byComment.get(fx.cE)).toEqual({ ...base, workItemId: fx.E });
    expect(byComment.get(fx.kE)).toEqual({ ...base, workItemId: fx.E });
    expect(byComment.get(fx.cS1)).toEqual({ ...base, workItemId: fx.S1 });
    expect(byComment.get(fx.cDoc)).toEqual({ ...base, documentId: fx.F });
    expect(byComment.get(fx.cFv)).toEqual({ ...base, fileVersionId: fx.fv, documentId: fx.F });

    const files = trail.filter((a) => a.action === "document.visibility_changed");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ targetId: fx.F });
    expect(files[0]!.metadata).toEqual({ from: "CLIENT_VISIBLE", to: "INTERNAL", via: "cascade", workItemId: fx.T1 });

    // Nothing else, and nothing about the skipped rows.
    expect(trail.map((a) => a.action).sort()).toEqual(
      [
        "work_item.bulk_edited",
        ...Array(4).fill("work_item.visibility_changed"),
        ...Array(5).fill("comment.visibility_changed"),
        "document.visibility_changed",
      ].sort(),
    );
    expect(trail.some((a) => a.targetId === fx.T3 || a.targetId === fx.T4 || a.targetId === fx.nT1)).toBe(false);
    // Ids and counts only (SECURITY.md §7): no title, no word, no name.
    const scanned = maskIds(trail.map((a) => a.metadata));
    expect(scanned).not.toContain(TOKEN);
    expect(scanned).not.toContain("Carol");
  }, LONG);
});

// ═══════════════════════════════════════════════════════════════════════

describe("the gate: work_item:change_visibility alone, and a scope FILTER, never a scope check", () => {
  /** In scope, shared, nothing under it. */
  let a1: string;
  /** In scope, private — the share's subject. */
  let b1: string;
  /** In scope, soft-deleted — the answer a foreign id must be indistinguishable from. */
  let gone: string;
  /** Acme's OTHER project — the two-project selection. */
  let o1: string;
  /** FOREIGN (beta): shared, with a shared child and a shared comment — so counting it would show. */
  let fx1: string;
  let fx1Child: string;
  /** FOREIGN (beta): private — so sharing it would show. */
  let fy1: string;

  beforeAll(async () => {
    a1 = await sharedTask("Scope A");
    b1 = await task("Scope B");
    gone = await sharedTask("Scope deleted");
    await deleteItem(ownerCtx(), gone);
    o1 = await sharedTask("Other project", pOther);
    fx1 = await sharedTask("Foreign shared", pBeta);
    fx1Child = await task("Foreign child", { parentId: fx1, projectId: pBeta });
    await memberComment(fx1, "CLIENT_VISIBLE", "Foreign comment");
    fy1 = await task("Foreign private", { projectId: pBeta });
    expect(await visOf(fx1Child)).toBe("CLIENT_VISIBLE");
  }, LONG);

  it("the custom seat holds exactly two codes, and really lacks work_item:edit", async () => {
    const held = await f.platform.rolePermission.findMany({
      where: { tenantId: f.tenantId, roleId: visOnly.roleId },
      select: { permission: { select: { code: true } } },
    });
    expect(held.map((h) => h.permission.code).sort()).toEqual(["work_item:change_visibility", "work_item:view"]);
    // The edit verbs refuse it — so the successes below are the
    // visibility code's alone, not a code it happened to hold as well.
    expect(await refusal(bulkSetPriority(ctxOf(visOnly.actor), [a1], "HIGH"))).toBe("authz:FORBIDDEN");
  });

  it("a foreign id alone is NOT_FOUND — the same answer a soft-deleted id gets — on all three verbs", async () => {
    const seat = ctxOf(visOnly.actor);
    for (const [name, verb] of [
      ["preview", (ids: string[]) => previewMakePrivate(seat, ids)],
      ["makePrivate", (ids: string[]) => makePrivateWithChildren(seat, ids)],
      ["share", (ids: string[]) => bulkShare(seat, ids)],
    ] as const) {
      const foreign = await refusal(verb([fx1]));
      const deleted = await refusal(verb([gone]));
      expect(foreign, name).toBe("authz:NOT_FOUND");
      expect(foreign, name).toBe(deleted);
      expect(await refusal(verb([fy1])), name).toBe("authz:NOT_FOUND");
    }
    expect(await visOf(fx1)).toBe("CLIENT_VISIBLE");
    expect(await visOf(fx1Child)).toBe("CLIENT_VISIBLE");
    expect(await visOf(fy1)).toBe("INTERNAL");
  }, LONG);

  it("a mixed selection succeeds for the seat with no edit code, and the foreign row is neither counted nor written", async () => {
    const seat = ctxOf(visOnly.actor);
    // Counted, fx1 would add a task, a task below and a comment.
    expect(await previewMakePrivate(seat, [a1, fx1])).toEqual({
      portalEnabled: true,
      tasks: 1,
      alreadyPrivate: 0,
      below: 0,
      comments: 0,
      files: 0,
      handedOver: 0,
      awaitingSignoff: 0,
    });
    expect(await makePrivateWithChildren(seat, [a1, fx1])).toEqual({
      tasks: 1,
      alreadyPrivate: 0,
      below: 0,
      comments: 0,
      files: 0,
      endedContactAssignments: 0,
    });
    expect(await visOf(a1)).toBe("INTERNAL");
    expect(await visOf(fx1)).toBe("CLIENT_VISIBLE");
    expect(await visOf(fx1Child)).toBe("CLIENT_VISIBLE");

    // Shared, fy1 would make `changed` 2.
    expect(await bulkShare(seat, [b1, fy1])).toEqual({ changed: 1, skipped: 0, clientComments: 0 });
    expect(await visOf(b1)).toBe("CLIENT_VISIBLE");
    expect(await visOf(fy1)).toBe("INTERNAL");
  }, LONG);

  it("the employee IN scope is FORBIDDEN on all three — it holds edit, not change_visibility", async () => {
    const employee = ctxOf(f.seats.employee.actor);
    const before = await visOf(b1);
    expect(await refusal(previewMakePrivate(employee, [b1]))).toBe("authz:FORBIDDEN");
    expect(await refusal(makePrivateWithChildren(employee, [b1]))).toBe("authz:FORBIDDEN");
    expect(await refusal(bulkShare(employee, [a1]))).toBe("authz:FORBIDDEN");
    expect(await visOf(b1)).toBe(before);
    // …and it IS in scope for the edit verbs: the refusal is the permission's.
    expect(await refusal(bulkSetPriority(employee, [b1], "LOW"))).toBe("resolved");
  }, LONG);

  it("a selection spanning two projects is INVALID_INPUT on all three", async () => {
    expect(await refusal(previewMakePrivate(ownerCtx(), [a1, o1]))).toBe("domain:INVALID_INPUT");
    expect(await refusal(makePrivateWithChildren(ownerCtx(), [b1, o1]))).toBe("domain:INVALID_INPUT");
    expect(await refusal(bulkShare(ownerCtx(), [a1, o1]))).toBe("domain:INVALID_INPUT");
    expect(await visOf(o1)).toBe("CLIENT_VISIBLE");
    expect(await visOf(b1)).toBe("CLIENT_VISIBLE");
  }, LONG);
});

// ═══════════════════════════════════════════════════════════════════════

/**
 * C37 — A CLIENT'S OWN COMMENTS FOLLOW THEIR TASK, AND NOTHING ELSE
 * DOES. The positive half is one row (K1); every other row below is a
 * negative control that a wrong predicate would publish to the client:
 *
 *   K1  Carol's comment                       → comes back
 *   K2  Carol's comment, deleted meanwhile    → stays private (and deleted)
 *   M1  a member's INTERNAL note              → stays private
 *   M2  a member's SHARED comment             → stays private (the cascade is not reversed)
 *   KF  Carol's comment on a FILE of the task → stays private (the file does not come back)
 *   X   a comment attributed to a contact of ANOTHER client, INTERNAL,
 *       planted raw (no FK binds the author)  → stays private — the belt
 *   S   a shared subtask handed to Carol      → stays private
 *   F2  the file                              → stays private
 *
 * Run once per raise path: the single flip, the bulk share, and a
 * hand-over that shares.
 */
describe("C37: a re-share brings back the client's own comments and nothing else", () => {
  async function plantR(label: string) {
    const R = await sharedTask(`Follow ${label}`);
    const K1 = await contactComment("WORK_ITEM", R, "First reply");
    const K2 = await contactComment("WORK_ITEM", R, "Second reply");
    const M1 = await memberComment(R, "INTERNAL", "Never shared");
    const M2 = await memberComment(R, "CLIENT_VISIBLE", "Shared once");
    const S = await task(`Subtask ${label}`, { parentId: R });
    await assignItemToContact(ownerCtx(), S, carol);
    const { documentId: F2 } = await plantFile(R, { visibility: "CLIENT_VISIBLE", name: `brief-${label}.txt` });
    // The census on a DOCUMENT subject: Carol's own INSERT, under her
    // principal (the guard share-locks the document, which the sign-off
    // migration made lockable by a contact).
    const KF = await contactComment("DOCUMENT", F2, "On the brief");
    // X: the belt. Attributed to Bo, a contact of BETA, on acme's task —
    // a shape only a system writer could produce, planted raw.
    const X = await rawComment({ subjectType: "WORK_ITEM", subjectId: R, visibility: "INTERNAL", words: "Misattributed", authorContactId: bo });
    const made = await makePrivateWithChildren(ownerCtx(), [R]);
    // K1, K2, M2 on R and KF on F2; X and M1 were already private.
    expect(made).toEqual({ tasks: 1, alreadyPrivate: 0, below: 1, comments: 4, files: 1, endedContactAssignments: 1 });
    for (const c of [K1, K2, M1, M2, KF, X]) expect(await commentVisOf(c), c).toBe("INTERNAL");
    // Removed by a member while private — `comment:delete` may remove a client's words.
    await deleteComment(ownerCtx(), K2);
    return { R, K1, K2, M1, M2, S, F2, KF, X };
  }

  for (const path of [
    {
      cause: "share",
      reshare: async (R: string) => {
        expect(await changeItemVisibility(ownerCtx(), R, "CLIENT_VISIBLE")).toMatchObject({ changed: true });
      },
    },
    {
      cause: "bulk_share",
      reshare: async (R: string) => {
        expect(await bulkShare(ownerCtx(), [R])).toEqual({ changed: 1, skipped: 0, clientComments: 1 });
      },
    },
    {
      cause: "contact_assignment",
      reshare: async (R: string) => {
        expect(await assignItemToContact(ownerCtx(), R, carol)).toMatchObject({ shared: true, changed: true });
        expect((await itemRow(R)).assigneeContactId).toBe(carol);
      },
    },
  ] as const) {
    it(`re-shared by ${path.cause}: K1 alone comes back, audited as following its task`, async () => {
      const x = await plantR(path.cause);
      const before = await auditIds();
      const historyBefore = await activityIds();
      await path.reshare(x.R);

      expect(await visOf(x.R)).toBe("CLIENT_VISIBLE");
      expect(await commentVisOf(x.K1)).toBe("CLIENT_VISIBLE");
      expect(await commentVisOf(x.K2)).toBe("INTERNAL");
      expect(await commentVisOf(x.M1)).toBe("INTERNAL");
      expect(await commentVisOf(x.M2)).toBe("INTERNAL");
      expect(await commentVisOf(x.KF)).toBe("INTERNAL");
      expect(await commentVisOf(x.X)).toBe("INTERNAL");
      expect(await visOf(x.S)).toBe("INTERNAL");
      expect(await docVisOf(x.F2)).toBe("INTERNAL");

      // What Carol can actually read on the task: exactly her own first reply.
      const seen = await withTenant(f.tenantId, contactOf(carol), (tx) =>
        tx.comment.findMany({ where: { subjectType: "WORK_ITEM", subjectId: x.R }, select: { id: true } }),
      );
      expect(seen.map((c) => c.id)).toEqual([x.K1]);

      const raised = (await auditsSince(before)).filter((a) => a.action === "comment.visibility_changed");
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({ targetId: x.K1 });
      expect(raised[0]!.metadata).toEqual({
        from: "INTERNAL",
        to: "CLIENT_VISIBLE",
        workItemId: x.R,
        projectId: pOn,
        via: "follows_task",
        cause: path.cause,
      });
      // Its history row is INTERNAL — `commentVisibility` is not portal-safe.
      const rows = (await activitySince(historyBefore)).filter((h) => h.field === "commentVisibility");
      expect(rows).toEqual([expect.objectContaining({ workItemId: x.R, commentId: x.K1, visibility: "INTERNAL" })]);
    }, LONG);
  }
});

// ═══════════════════════════════════════════════════════════════════════

describe("selections that hold a parent and its child", () => {
  it("make private: both selected are two tasks with nothing below, one audit each and no duplicate history", async () => {
    const t = await sharedTask("Parent in the selection");
    const st = await task("Child in the selection", { parentId: t });
    expect(await previewMakePrivate(ownerCtx(), [t, st])).toEqual({
      portalEnabled: true,
      tasks: 2,
      alreadyPrivate: 0,
      below: 0,
      comments: 0,
      files: 0,
      handedOver: 0,
      awaitingSignoff: 0,
    });
    const auditsBefore = await auditIds();
    const historyBefore = await activityIds();
    expect(await makePrivateWithChildren(ownerCtx(), [st, t])).toEqual({
      tasks: 2,
      alreadyPrivate: 0,
      below: 0,
      comments: 0,
      files: 0,
      endedContactAssignments: 0,
    });
    const trail = await auditsSince(auditsBefore);
    expect(
      trail
        .filter((a) => a.action === "work_item.visibility_changed")
        .map((a) => a.targetId)
        .sort(),
    ).toEqual([t, st].sort());
    const bulk = trail.filter((a) => a.action === "work_item.bulk_edited");
    expect(bulk).toHaveLength(1);
    expect(bulk[0]!.metadata).toMatchObject({ tasks: 2, below: 0 });
    const history = await activitySince(historyBefore);
    expect(history.map((h) => `${h.workItemId}:${h.field}`).sort()).toEqual([`${t}:visibility`, `${st}:visibility`].sort());
  }, LONG);

  it("share: an EPIC, its TASK and its SUBTASK, all private and all selected, are shared parent first", async () => {
    const e = await epic("Share tree");
    const t = await task("Share tree task", { parentId: e });
    const s = await task("Share tree subtask", { parentId: t });
    const before = await auditIds();
    // Deliberately child-first in the argument: the order is the service's.
    expect(await bulkShare(ownerCtx(), [s, t, e])).toEqual({ changed: 3, skipped: 0, clientComments: 0 });
    for (const id of [e, t, s]) expect(await visOf(id)).toBe("CLIENT_VISIBLE");
    const trail = await auditsSince(before);
    expect(trail.filter((a) => a.action === "work_item.bulk_edited").map((a) => a.metadata)).toEqual([
      { projectId: pOn, reason: "share", count: 3 },
    ]);
    const shared = trail.filter((a) => a.action === "work_item.visibility_changed");
    expect(shared.map((a) => a.targetId).sort()).toEqual([e, t, s].sort());
    for (const a of shared) {
      expect(a.metadata).toEqual({ from: "INTERNAL", to: "CLIENT_VISIBLE", projectId: pOn, bulk: true });
    }
  }, LONG);

  /**
   * THE REFUSE-UP. Both cases would ALSO be refused by the tree trigger
   * (`WORK_TREE_CHILD_VISIBILITY` → PARENT_NOT_VISIBLE, the belt): in (b)
   * the level-by-level UPDATE would share the epic and then meet the
   * subtask's private parent, and roll the epic back with it; in (c) the
   * one UPDATE meets it at once. So these prove the service check AND
   * the belt together — the answer is the same whichever is removed,
   * and what is pinned is that nothing at all is written.
   */
  it("share: a selected subtask whose private parent is NOT selected refuses the whole batch, and writes nothing", async () => {
    const e = await epic("Refuse-up epic");
    const t = await task("Refuse-up task", { parentId: e });
    const s = await task("Refuse-up subtask", { parentId: t });
    const lone = await task("Refuse-up lone parent");
    const loneChild = await task("Refuse-up lone child", { parentId: lone });
    const auditsBefore = await auditIds();
    const historyBefore = await activityIds();

    // (b) subtask + epic, with the task between them private and unselected.
    expect(await refusal(bulkShare(ownerCtx(), [s, e]))).toBe("domain:PARENT_NOT_VISIBLE");
    // (c) a child alone under a private parent.
    expect(await refusal(bulkShare(ownerCtx(), [loneChild]))).toBe("domain:PARENT_NOT_VISIBLE");

    for (const id of [e, t, s, lone, loneChild]) expect(await visOf(id)).toBe("INTERNAL");
    expect(await auditsSince(auditsBefore)).toEqual([]);
    expect(await activitySince(historyBefore)).toEqual([]);
  }, LONG);
});

// ═══════════════════════════════════════════════════════════════════════

describe("the lever always works", () => {
  it("NO CAP: a task with 600 client-visible comments — 50 of them the client's — goes private in one call", async () => {
    const n = await sharedTask("Long-lived thread");
    await f.platform.comment.createMany({
      data: Array.from({ length: 600 }, (_, i) => ({
        tenantId: f.tenantId,
        subjectType: "WORK_ITEM" as const,
        subjectId: n,
        authorMemberId: i < 50 ? null : f.seats.owner.memberId,
        authorContactId: i < 50 ? carol : null,
        body: doc(W(`reply ${i}`)),
        bodyText: W(`reply ${i}`),
        visibility: "CLIENT_VISIBLE" as const,
      })),
    });
    const made = await makePrivateWithChildren(ownerCtx(), [n]);
    expect(made).toEqual({ tasks: 1, alreadyPrivate: 0, below: 0, comments: 600, files: 0, endedContactAssignments: 0 });
    expect(await visOf(n)).toBe("INTERNAL");
    expect(
      await f.platform.comment.count({ where: { tenantId: f.tenantId, subjectId: n, visibility: "CLIENT_VISIBLE" } }),
    ).toBe(0);
    expect(await f.platform.comment.count({ where: { tenantId: f.tenantId, subjectId: n, visibility: "INTERNAL" } })).toBe(
      600,
    );
  }, LONG);

  it("with the documentation module switched OFF by the tenant, the cascade still lowers an attached file", async () => {
    const d = await sharedTask("Docs off");
    const { documentId } = await plantFile(d, { visibility: "CLIENT_VISIBLE", name: "docs-off.txt" });
    await f.platform.tenantPreference.create({
      data: { tenantId: f.tenantId, key: "module.documentation.enabled", value: false },
    });
    try {
      // The switch really is off — the documents module's own read refuses.
      expect(await refusal(listDocuments(ownerCtx(), { attachedToWorkItemId: d }))).toBe("authz:DISABLED_BY_TENANT");
      // …and the lever does not ask it.
      expect(await makePrivateWithChildren(ownerCtx(), [d])).toMatchObject({ tasks: 1, files: 1 });
    } finally {
      await f.platform.tenantPreference.deleteMany({
        where: { tenantId: f.tenantId, key: "module.documentation.enabled" },
      });
    }
    expect(await visOf(d)).toBe("INTERNAL");
    expect(await docVisOf(documentId)).toBe("INTERNAL");
  }, LONG);

  it("a cascade that cannot get its locks is told VISIBILITY_BUSY, writes nothing, and goes through once they are free", async () => {
    const id = await sharedTask("Busy queue");
    await memberComment(id, "CLIENT_VISIBLE", "Blocks the plain flip");
    const before = await auditIds();
    // The project's rank queue, held by a colleague for longer than all
    // three attempts' bounded waits (`lock_timeout` covers advisory locks).
    const holder = holdOpen(member(), (tx) => lockProjectRanks(tx, pOn), 120_000);
    const started = Date.now();
    try {
      await holder.isReady;
      expect(await refusal(makePrivateWithChildren(ownerCtx(), [id]))).toBe("domain:VISIBILITY_BUSY");
    } finally {
      holder.release();
      await holder.done;
    }
    // It waited for the bound rather than failing at once — at least one
    // whole lock wait (5 s unscaled; no upper bound, the budgets scale).
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
    expect(await visOf(id)).toBe("CLIENT_VISIBLE");
    expect(await auditsSince(before)).toEqual([]);
    // Free again: the same call goes through.
    expect(await makePrivateWithChildren(ownerCtx(), [id])).toMatchObject({ tasks: 1, comments: 1 });
  }, 360_000);
});

// ═══════════════════════════════════════════════════════════════════════

/**
 * THE REVERSE RACES — the property that makes "make private" hold even
 * against a writer hanging a new client-visible child under the task
 * while the cascade runs. Each writer takes FOR SHARE on the task (the
 * comment guard, the attachment guard); the cascade's FOR NO KEY UPDATE
 * on the root must WAIT for it, and is seen waiting on that writer's own
 * transaction id before the writer commits. Then the cascade reads the
 * closure fresh and lowers the newcomer with the rest.
 */
describe("the reverse races: a child arriving while the cascade waits is lowered with the rest", () => {
  const base = { from: "CLIENT_VISIBLE", to: "INTERNAL", via: "cascade" };

  it("a member's shared comment, inserted and held", async () => {
    const root = await sharedTask("Race comment");
    const before = await auditIds();
    const { held: commentId, result } = await raceBehind(
      member(),
      async (tx) =>
        (
          await tx.comment.create({
            data: {
              tenantId: f.tenantId,
              subjectType: "WORK_ITEM",
              subjectId: root,
              authorMemberId: f.seats.owner.memberId,
              body: doc(W("Late reply")),
              bodyText: W("Late reply"),
              visibility: "CLIENT_VISIBLE",
            },
            select: { id: true },
          })
        ).id,
      () => makePrivateWithChildren(ownerCtx(), [root]),
    );
    expect(await result).toEqual({ tasks: 1, alreadyPrivate: 0, below: 0, comments: 1, files: 0, endedContactAssignments: 0 });
    expect(await visOf(root)).toBe("INTERNAL");
    expect(await commentVisOf(commentId)).toBe("INTERNAL");
    const lowered = (await auditsSince(before)).filter((a) => a.action === "comment.visibility_changed");
    expect(lowered).toHaveLength(1);
    expect(lowered[0]).toMatchObject({ targetId: commentId });
    expect(lowered[0]!.metadata).toEqual({ ...base, projectId: pOn, workItemId: root });
  }, LONG);

  it("an attachment raised to client-visible and held", async () => {
    const root = await sharedTask("Race file");
    const { documentId } = await plantFile(root, { visibility: "INTERNAL", name: "race.txt" });
    const before = await auditIds();
    const { result } = await raceBehind(
      member(),
      (tx) =>
        tx.document.update({ where: { id: documentId }, data: { visibility: "CLIENT_VISIBLE" }, select: { id: true } }),
      () => makePrivateWithChildren(ownerCtx(), [root]),
    );
    expect(await result).toEqual({ tasks: 1, alreadyPrivate: 0, below: 0, comments: 0, files: 1, endedContactAssignments: 0 });
    expect(await visOf(root)).toBe("INTERNAL");
    expect(await docVisOf(documentId)).toBe("INTERNAL");
    const lowered = (await auditsSince(before)).filter((a) => a.action === "document.visibility_changed");
    expect(lowered).toHaveLength(1);
    expect(lowered[0]).toMatchObject({ targetId: documentId });
    expect(lowered[0]!.metadata).toEqual({ ...base, workItemId: root });
  }, LONG);

  it("the client's own comment, inserted under the contact principal and held", async () => {
    const root = await sharedTask("Race contact comment");
    const before = await auditIds();
    const { held: commentId, result } = await raceBehind(
      contactOf(carol),
      async (tx) =>
        (
          await tx.comment.create({
            data: {
              tenantId: f.tenantId,
              subjectType: "WORK_ITEM",
              subjectId: root,
              authorContactId: carol,
              body: doc(W("Client, just in time")),
              bodyText: W("Client, just in time"),
              visibility: "CLIENT_VISIBLE",
            },
            select: { id: true },
          })
        ).id,
      () => makePrivateWithChildren(ownerCtx(), [root]),
    );
    expect(await result).toEqual({ tasks: 1, alreadyPrivate: 0, below: 0, comments: 1, files: 0, endedContactAssignments: 0 });
    expect(await visOf(root)).toBe("INTERNAL");
    expect(await commentVisOf(commentId)).toBe("INTERNAL");
    const lowered = (await auditsSince(before)).filter((a) => a.action === "comment.visibility_changed");
    expect(lowered.map((a) => a.targetId)).toEqual([commentId]);
    expect(lowered[0]!.metadata).toEqual({ ...base, projectId: pOn, workItemId: root });
  }, LONG);
});

// ═══════════════════════════════════════════════════════════════════════

describe("makeItemPrivate — the single door", () => {
  it("falls back to the cascade when something below is still shared, and says what else went", async () => {
    const t = await sharedTask("Door with a child");
    const st = await task("Door child", { parentId: t });
    const before = await auditIds();
    expect(await makeItemPrivate(ownerCtx(), t)).toEqual({
      id: t,
      visibility: "INTERNAL",
      endedContactAssignment: false,
      changed: true,
      alsoPrivate: { below: 1, comments: 0, files: 0, endedContactAssignments: 0 },
    });
    expect(await visOf(st)).toBe("INTERNAL");
    const trail = await auditsSince(before);
    // The refused plain flip rolled back whole: only the cascade's rows.
    expect(trail.map((a) => a.action).sort()).toEqual(
      ["work_item.bulk_edited", "work_item.visibility_changed", "work_item.visibility_changed"].sort(),
    );
    expect(trail.find((a) => a.action === "work_item.bulk_edited")!.metadata).toEqual({
      projectId: pOn,
      reason: "make_private",
      tasks: 1,
      below: 1,
      comments: 0,
      files: 0,
      endedContactAssignments: 0,
    });
  }, LONG);

  it("is the plain flip when nothing is below — alsoPrivate null, and no bulk_edited row", async () => {
    const t = await sharedTask("Door alone");
    const before = await auditIds();
    expect(await makeItemPrivate(ownerCtx(), t)).toEqual({
      id: t,
      visibility: "INTERNAL",
      endedContactAssignment: false,
      changed: true,
      alsoPrivate: null,
    });
    const trail = await auditsSince(before);
    expect(trail.map((a) => a.action)).toEqual(["work_item.visibility_changed"]);
    // The single flip's own audit, not the cascade's.
    expect(trail[0]!.metadata).toEqual({ from: "CLIENT_VISIBLE", to: "INTERNAL", projectId: pOn });
  }, LONG);

  it("reports the ended hand-over of THIS task when the cascade ran", async () => {
    const t = await sharedTask("Door handed over");
    await task("Door handed child", { parentId: t });
    await assignItemToContact(ownerCtx(), t, carol);
    const out = await makeItemPrivate(ownerCtx(), t);
    expect(out).toMatchObject({ id: t, visibility: "INTERNAL", endedContactAssignment: true, changed: true });
    // What ELSE went: the root's own hand-over is `endedContactAssignment`,
    // never counted again among the ones below it.
    expect(out.alsoPrivate).toEqual({ below: 1, comments: 0, files: 0, endedContactAssignments: 0 });
    expect(await itemRow(t)).toMatchObject({ assigneeContactId: null, contactCompletedAt: null });
  }, LONG);
});

describe("a single raise brings the client's own comment back", () => {
  it("changeItemVisibility's share raises an INTERNAL contact comment, audited as following its task", async () => {
    const q = await task("Single raise");
    // The shape a make-private leaves behind: Carol's words, INTERNAL, on
    // a private task — planted raw because no census INSERT can make it.
    const k = await rawComment({ subjectType: "WORK_ITEM", subjectId: q, visibility: "INTERNAL", words: "Mine", authorContactId: carol });
    const before = await auditIds();
    expect(await changeItemVisibility(ownerCtx(), q, "CLIENT_VISIBLE")).toMatchObject({ changed: true });
    expect(await commentVisOf(k)).toBe("CLIENT_VISIBLE");
    const raised = (await auditsSince(before)).filter((a) => a.action === "comment.visibility_changed");
    expect(raised.map((a) => a.targetId)).toEqual([k]);
    expect(raised[0]!.metadata).toEqual({
      from: "INTERNAL",
      to: "CLIENT_VISIBLE",
      workItemId: q,
      projectId: pOn,
      via: "follows_task",
      cause: "share",
    });
  }, LONG);
});
