import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { listPortalDocuments, listPortalPendingDeliverables } from "@/documents/portal";
import { decidePortalDeliverable } from "@/documents/portal-signoff";
import {
  addVersion,
  commitUpload,
  createUpload,
  requestDocumentSignoff,
  type DocumentCtx,
} from "@/documents/service";
import { DomainError } from "@/lib/domain-error";
import { setupTenant } from "@/members/dbtest-fixture";
import { listPortalTimeline, type PortalTimelineEntry } from "@/modules/work";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { parseSignoffInput } from "@/portal/signoff";
import { listPortalPendingVersions } from "@/projects/portal";
import { decidePortalVersion } from "@/projects/portal-signoff";
import { createVersion, requestVersionSignoff, shipVersion } from "@/projects/versions";
import { LocalDiskTransport, setStorage } from "@/storage";

/**
 * VERSION SIGN-OFF AGAINST THE REAL SCHEMA (Phase 3, decision #7
 * v1-lite; migration 20260927120000): the member's ask, the client's
 * answer written UNDER THE CONTACT PRINCIPAL through the census, and
 * what every projection then says.
 *
 * WHAT ONLY A DATABASE CAN SAY, and why this file exists beside
 * `census.dbtest.ts` (which pins the SHAPE of the carve-out): that a
 * contact's decision really lands under RLS — that every write outside
 * the carve-out is REFUSED, measured with raw updates under a real
 * contact transaction (the assertions accept any of the three layers'
 * refusals — the policy, the column trigger, the transition trigger —
 * because which fires first is Postgres's order, not a contract; what
 * is measured is that none lets the write through), and that the one
 * admitted write works; that the audit row is the CONTACT's, inside that
 * transaction; that the agency's inbox row exists afterwards; that a
 * second decision on a decided row changes nothing and audits nothing;
 * and that every projection carries the ask and the answer with the
 * reader's own `canDecide` and never another client's words.
 *
 * THE SENTINEL WALK, as in every portal suite: Beta's open ask carries
 * a title and a name that exist nowhere else, and the serialised output
 * of every read Carol makes is searched for them.
 *
 * Tenant slug prefix `psign-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

const run = randomUUID().slice(0, 8);

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let storage: LocalDiskTransport;
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-psign-"));

let acme: string;
let beta: string;
let pOn: string;
let pOff: string;
let pArchived: string;
let pBeta: string;
let carol: string;
let dan: string;
let bo: string;
let sue: string;

/** Shipped and ASKED on the reachable project — the one Carol approves. */
let askedId: string;
/** Shipped and asked — the raw-SQL positive control decides this one. */
let rawAskedId: string;
/** Shipped and asked — stays PENDING to the end, for the pending lists. */
let stillAskedId: string;
/** Shipped, never asked. */
let unaskedId: string;
/** A draft. */
let draftId: string;
/** Open asks the gate must keep out of reach (planted). */
let offAskedId: string;
let archivedAskedId: string;
let betaAskedId: string;
/** The shared deliverable Carol asks for changes on. */
let deliverableId: string;
/** A deliverable shared with the company itself, asked. */
let companyDeliverableId: string;
/** A shared GENERAL file, an INTERNAL deliverable — never askable. */
let generalId: string;
let internalDeliverableId: string;
/** Beta's asked deliverable. */
let betaDeliverableId: string;

const SHOWN = {
  asked: `1.${run.slice(0, 3)}`,
  rawAsked: `2.${run.slice(0, 3)}`,
  stillAsked: `3.${run.slice(0, 3)}`,
  unasked: `4.${run.slice(0, 3)}`,
  deliverable: `design-${run}.txt`,
  companyDeliverable: `brand-${run}.txt`,
  note: `Please make the logo bigger ${run}`,
} as const;

const S = {
  betaVersion: `SENTINELBETAVERSION-${run}`,
  betaDeliverable: `SENTINELBETADELIVERABLE-${run}.txt`,
  betaNote: `SENTINELBETANOTE-${run}`,
  offVersion: `SENTINELOFFVERSION-${run}`,
  archivedVersion: `SENTINELARCHIVEDVERSION-${run}`,
  internalDeliverable: `SENTINELINTERNALDELIVERABLE-${run}.txt`,
} as const;

const ctxOf = (seat: "owner" | "employee"): DocumentCtx => ({ tenantId: f.tenantId, actor: f.seats[seat].actor });

const principal = (contactId: string, clientId = acme): PortalPrincipal => ({
  contactId,
  tenantId: f.tenantId,
  clientId,
  gates,
});

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

const keyOf = (url: string): string =>
  new URL(url).pathname.replace(/^\/api\/dev-storage\//, "").split("/").map(decodeURIComponent).join("/");

const putBytes = async (uploadUrl: string, headers: Record<string, string>, body: Uint8Array) => {
  const res = await storage.handlePut(
    new Request(uploadUrl, { method: "PUT", headers, body: Buffer.from(body) }),
    keyOf(uploadUrl),
  );
  expect(res.status).toBe(200);
};

/** A document through the real service: presign → PUT → commit. */
const upload = async (
  name: string,
  visibility: "INTERNAL" | "CLIENT_VISIBLE",
  scope: { clientId?: string; projectId?: string },
  kind: "GENERAL" | "DELIVERABLE",
): Promise<string> => {
  const body = new TextEncoder().encode(`${name}\n`);
  const presigned = await createUpload(ctxOf("owner"), {
    name,
    contentType: "text/plain",
    sizeBytes: body.byteLength,
    sha256: sha(body),
    ...scope,
    visibility,
  });
  await putBytes(presigned.uploadUrl, { ...presigned.headers }, body);
  const { documentId } = await commitUpload(ctxOf("owner"), {
    fileObjectId: presigned.fileObjectId,
    ...scope,
    visibility,
    kind,
  });
  return documentId;
};

const version = async (documentId: string, scope: { clientId?: string; projectId?: string }, text: string) => {
  const body = new TextEncoder().encode(text);
  const presigned = await createUpload(ctxOf("owner"), {
    name: `v-${run}.txt`,
    contentType: "text/plain",
    sizeBytes: body.byteLength,
    sha256: sha(body),
    ...scope,
  });
  await putBytes(presigned.uploadUrl, { ...presigned.headers }, body);
  return addVersion(ctxOf("owner"), { documentId, fileObjectId: presigned.fileObjectId });
};

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

const expectNoSentinel = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const [name, sentinel] of Object.entries(S)) {
    expect(json, `sentinel ${name} leaked`).not.toContain(sentinel);
  }
};

/** A raw write under Carol's OWN principal — the census, measured. */
const asCarol = <T,>(fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
  withTenant(f.tenantId, { type: "contact", id: carol, clientId: acme }, fn);

const auditRows = (action: string, targetId: string) =>
  f.platform.auditEvent.findMany({
    where: { tenantId: f.tenantId, action, targetId },
    select: { actorType: true, actorId: true, metadata: true, visibility: true },
  });

const inboxRows = (entityId: string) =>
  f.platform.notification.findMany({
    where: { tenantId: f.tenantId, kind: "approval.decided", entityId },
    select: { receiverId: true, params: true, entityType: true },
  });

beforeAll(async () => {
  storage = new LocalDiskTransport(storageDir);
  setStorage(storage);
  f = await setupTenant("psign");
  gates = await resolvePortalModuleGates(f.tenantId);
  acme = randomUUID();
  beta = randomUUID();
  pOn = randomUUID();
  pOff = randomUUID();
  pArchived = randomUUID();
  pBeta = randomUUID();
  carol = randomUUID();
  dan = randomUUID();
  bo = randomUUID();
  sue = randomUUID();
  const up = run.slice(0, 3).toUpperCase();

  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: pOn, tenantId: f.tenantId, clientId: acme, key: `PSG${up}`, name: `Site ${run}`, portalEnabled: true },
      { id: pOff, tenantId: f.tenantId, clientId: acme, key: `PSO${up}`, name: `Off ${run}`, portalEnabled: false },
      {
        id: pArchived,
        tenantId: f.tenantId,
        clientId: acme,
        key: `PSA${up}`,
        name: `Archived ${run}`,
        portalEnabled: true,
        status: "ARCHIVED",
        archivedAt: new Date("2026-01-01T00:00:00Z"),
      },
      { id: pBeta, tenantId: f.tenantId, clientId: beta, key: `PSB${up}`, name: `Beta site ${run}`, portalEnabled: true },
    ],
  });
  // The employee is on the project, so a decision has somebody to tell.
  await f.platform.memberProject.create({
    data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId: pOn },
  });
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  await f.platform.contact.createMany({
    data: [
      { id: carol, tenantId: f.tenantId, clientId: acme, name: "Carol", email: `psign-carol-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: dan, tenantId: f.tenantId, clientId: acme, name: "Dan", email: `psign-dan-${run}@test.invalid`, portalProfile: "CONTACT_COLLABORATOR", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: bo, tenantId: f.tenantId, clientId: beta, name: "Bo", email: `psign-bo-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: sue, tenantId: f.tenantId, clientId: acme, name: "Sue", email: `psign-sue-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "SUSPENDED", invitedAt, emailVerified: true },
    ],
  });

  // ── Versions, through the real services ────────────────────────────
  const owner = ctxOf("owner");
  const ship = async (projectId: string, label: string, title?: string) => {
    const { id } = await createVersion(owner, { projectId, version: label, title: title ?? null });
    await shipVersion(owner, id);
    return id;
  };
  askedId = await ship(pOn, SHOWN.asked, "Go live");
  await requestVersionSignoff(owner, askedId);
  rawAskedId = await ship(pOn, SHOWN.rawAsked);
  await requestVersionSignoff(owner, rawAskedId);
  stillAskedId = await ship(pOn, SHOWN.stillAsked);
  await requestVersionSignoff(owner, stillAskedId);
  unaskedId = await ship(pOn, SHOWN.unasked);
  draftId = (await createVersion(owner, { projectId: pOn, version: `9.${run.slice(0, 3)}` })).id;

  // Open asks the gate must keep out of reach. Planted directly, because
  // the service refuses each of these shapes on purpose.
  const planted = async (projectId: string, clientId: string, title: string) => {
    const id = randomUUID();
    await f.platform.projectVersion.create({
      data: {
        id,
        tenantId: f.tenantId,
        clientId,
        projectId,
        version: `p.${id.slice(0, 4)}`,
        title,
        status: "SHIPPED",
        shippedAt: new Date("2026-06-01T10:00:00Z"),
        approvalStatus: "PENDING",
        approvalRequestedAt: new Date("2026-06-02T10:00:00Z"),
      },
    });
    return id;
  };
  offAskedId = await planted(pOff, acme, S.offVersion);
  archivedAskedId = await planted(pArchived, acme, S.archivedVersion);
  betaAskedId = await planted(pBeta, beta, S.betaVersion);

  // ── Documents, through the real upload path ────────────────────────
  deliverableId = await upload(SHOWN.deliverable, "CLIENT_VISIBLE", { projectId: pOn }, "DELIVERABLE");
  await requestDocumentSignoff(owner, deliverableId);
  companyDeliverableId = await upload(SHOWN.companyDeliverable, "CLIENT_VISIBLE", { clientId: acme }, "DELIVERABLE");
  await requestDocumentSignoff(owner, companyDeliverableId);
  generalId = await upload(`notes-${run}.txt`, "CLIENT_VISIBLE", { projectId: pOn }, "GENERAL");
  internalDeliverableId = await upload(S.internalDeliverable, "INTERNAL", { projectId: pOn }, "DELIVERABLE");
  betaDeliverableId = await upload(S.betaDeliverable, "CLIENT_VISIBLE", { projectId: pBeta }, "DELIVERABLE");
  await requestDocumentSignoff(owner, betaDeliverableId);
  // Bo answers his own ask with words that exist nowhere else.
  await decidePortalDeliverable(principal(bo, beta), betaDeliverableId, {
    decision: "CHANGES_REQUESTED",
    note: S.betaNote,
  });
}, 180_000);

afterAll(async () => {
  if (!f) return;
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.fileVersion.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.document.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.fileObject.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.projectVersion.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
  setStorage(null);
  rmSync(storageDir, { recursive: true, force: true });
}, 60_000);

describe("the member's ask", () => {
  it("refuses what the client could not see, an open ask, and a standing approval", async () => {
    const owner = ctxOf("owner");
    expect(await domainCode(requestVersionSignoff(owner, draftId))).toBe("SIGNOFF_NOT_SHAREABLE");
    const offShipped = (await createVersion(owner, { projectId: pOff, version: `o.${run.slice(0, 3)}` })).id;
    await shipVersion(owner, offShipped);
    expect(await domainCode(requestVersionSignoff(owner, offShipped))).toBe("SIGNOFF_NOT_SHAREABLE");
    expect(await domainCode(requestVersionSignoff(owner, askedId))).toBe("SIGNOFF_ALREADY_REQUESTED");

    expect(await domainCode(requestDocumentSignoff(owner, generalId))).toBe("SIGNOFF_NOT_SHAREABLE");
    expect(await domainCode(requestDocumentSignoff(owner, internalDeliverableId))).toBe("SIGNOFF_NOT_SHAREABLE");
    expect(await domainCode(requestDocumentSignoff(owner, deliverableId))).toBe("SIGNOFF_ALREADY_REQUESTED");
  });

  it("stamps the ask with the newest committed version, and audits it", async () => {
    const doc = await f.platform.document.findFirstOrThrow({ where: { id: deliverableId } });
    expect(doc.approvalStatus).toBe("PENDING");
    expect(doc.approvalVersionNumber).toBe(1);
    expect(doc.approvalRequestedAt).not.toBeNull();
    const rows = await auditRows("document.approval_requested", deliverableId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "MEMBER", metadata: { versionNumber: 1, previous: "NOT_REQUESTED" } });
    expect(await auditRows("project_version.approval_requested", askedId)).toHaveLength(1);
  });
});

describe("what the projections say before any decision", () => {
  it("the rail carries the ask on the version, with the reader's own canDecide", async () => {
    const primary = await listPortalTimeline(principal(carol), { projectId: pOn });
    const asked = primary.entries.find((e) => e.kind === "version_shipped" && e.id === askedId);
    expect(asked).toMatchObject({
      approval: { status: "PENDING", decidedAt: null, note: null, canDecide: true },
    });
    const unasked = primary.entries.find((e) => e.kind === "version_shipped" && e.id === unaskedId);
    expect(unasked).toMatchObject({ approval: { status: "NOT_REQUESTED", canDecide: false } });
    expect(Object.keys(asked!).sort()).toEqual(["approval", "at", "id", "kind", "releaseNotes", "title", "version"]);
    expect(Object.keys((asked as { approval: object }).approval).sort()).toEqual(["canDecide", "decidedAt", "note", "status"]);
    // No decision yet: no decision entry.
    expect(primary.entries.some((e) => e.kind === "approval_decided")).toBe(false);
    expectNoSentinel(primary);

    // A collaborator reads the same ask and is offered nothing.
    const collaborator = await listPortalTimeline(principal(dan), { projectId: pOn });
    const askedForDan = collaborator.entries.find((e) => e.kind === "version_shipped" && e.id === askedId);
    expect(askedForDan).toMatchObject({ approval: { status: "PENDING", canDecide: false } });
  });

  it("the files list carries the ask on the deliverable and nothing on other kinds", async () => {
    const { documents } = await listPortalDocuments(principal(carol));
    const deliverable = documents.find((d) => d.id === deliverableId)!;
    expect(deliverable.approval).toEqual({
      status: "PENDING",
      decidedAt: null,
      note: null,
      versionNumber: 1,
      canDecide: true,
    });
    expect(documents.find((d) => d.id === generalId)!.approval).toBeNull();
    expect(Object.keys(deliverable).sort()).toEqual(["approval", "id", "kind", "name", "project", "version"]);
    expectNoSentinel(documents);
    const forDan = await listPortalDocuments(principal(dan));
    expect(forDan.documents.find((d) => d.id === deliverableId)!.approval).toMatchObject({ canDecide: false });
  });

  it("the pending lists are the reader's own open asks, oldest first — and empty for a collaborator", async () => {
    const versions = await listPortalPendingVersions(principal(carol));
    expect(versions.map((v) => v.id)).toEqual([askedId, rawAskedId, stillAskedId]);
    expect(versions[0]).toMatchObject({ kind: "version", version: SHOWN.asked, title: "Go live", project: { id: pOn } });
    const deliverables = await listPortalPendingDeliverables(principal(carol));
    expect(deliverables.map((d) => d.id)).toEqual([deliverableId, companyDeliverableId]);
    expect(deliverables[1]).toMatchObject({ kind: "deliverable", name: SHOWN.companyDeliverable, versionNumber: 1, project: null });
    expectNoSentinel(versions);
    expectNoSentinel(deliverables);
    expect(await listPortalPendingVersions(principal(dan))).toEqual([]);
    expect(await listPortalPendingDeliverables(principal(dan))).toEqual([]);
    // Bo's are Bo's: Beta's ask and no Acme's.
    const bos = await listPortalPendingVersions(principal(bo, beta));
    expect(bos.map((v) => v.id)).toEqual([betaAskedId]);
  });
});

describe("the client's answer", () => {
  it("refuses a decision that says nothing, an unknown decision, and an over-long note", () => {
    expect(() => parseSignoffInput({ decision: "CHANGES_REQUESTED", note: "  " })).toThrow(DomainError);
    expect(() => parseSignoffInput({ decision: "MAYBE", note: null })).toThrow(DomainError);
    expect(() => parseSignoffInput({ decision: "APPROVED", note: "x".repeat(2001) })).toThrow(DomainError);
    expect(parseSignoffInput({ decision: "APPROVED", note: "  " })).toEqual({ decision: "APPROVED", note: null });
  });

  it("is refused to a collaborator, a suspended contact, and anyone outside the row's gate", async () => {
    const approve = { decision: "APPROVED" as const, note: null };
    expect(await authzReason(decidePortalVersion(principal(dan), askedId, approve))).toBe("FORBIDDEN");
    expect(await authzReason(decidePortalDeliverable(principal(dan), deliverableId, approve))).toBe("FORBIDDEN");
    expect(await authzReason(decidePortalVersion(principal(sue), askedId, approve))).toBe("FORBIDDEN");
    // Another client's contact: Acme's version does not exist for Bo.
    expect(await authzReason(decidePortalVersion(principal(bo, beta), askedId, approve))).toBe("NOT_FOUND");
    // Carol cannot reach Beta's, a switched-off project's, an archived project's, a draft, or an unasked version.
    expect(await authzReason(decidePortalVersion(principal(carol), betaAskedId, approve))).toBe("NOT_FOUND");
    expect(await authzReason(decidePortalVersion(principal(carol), offAskedId, approve))).toBe("NOT_FOUND");
    expect(await authzReason(decidePortalVersion(principal(carol), archivedAskedId, approve))).toBe("NOT_FOUND");
    expect(await authzReason(decidePortalVersion(principal(carol), draftId, approve))).toBe("NOT_FOUND");
    expect(await authzReason(decidePortalVersion(principal(carol), unaskedId, approve))).toBe("NOT_FOUND");
    expect(await authzReason(decidePortalDeliverable(principal(carol), betaDeliverableId, approve))).toBe("NOT_FOUND");
    expect(await authzReason(decidePortalDeliverable(principal(carol), internalDeliverableId, approve))).toBe("NOT_FOUND");
    expect(await authzReason(decidePortalDeliverable(principal(carol), generalId, approve))).toBe("NOT_FOUND");
    // Nothing was written by any of those.
    for (const id of [askedId, betaAskedId, offAskedId, archivedAskedId, unaskedId]) {
      const row = await f.platform.projectVersion.findFirstOrThrow({ where: { id } });
      expect(row.approvalDecidedAt).toBeNull();
    }
  });

  it("the census, measured raw: only the four columns, only by the principal, only on a PENDING row", async () => {
    // Any other column: refused by the column trigger before RLS gets a turn.
    await expect(
      asCarol((tx) => tx.projectVersion.updateMany({ where: { id: rawAskedId }, data: { title: "Owned" } })),
    ).rejects.toThrow(/PORTAL_COLUMNS|row-level security/);
    // A decision naming somebody else: refused by the transition trigger and the policy.
    await expect(
      asCarol((tx) =>
        tx.projectVersion.updateMany({
          where: { id: rawAskedId },
          data: { approvalStatus: "APPROVED", approvalDecidedAt: new Date(), approvalByContactId: dan },
        }),
      ),
    ).rejects.toThrow(/PORTAL_APPROVAL|row-level security/);
    // A decision on a row nobody asked about.
    await expect(
      asCarol((tx) =>
        tx.projectVersion.updateMany({
          where: { id: unaskedId },
          data: { approvalStatus: "APPROVED", approvalDecidedAt: new Date(), approvalByContactId: carol },
        }),
      ),
    ).rejects.toThrow(/PORTAL_APPROVAL|row-level security|check constraint/);
    // Back to PENDING is not a decision either.
    await expect(
      asCarol((tx) =>
        tx.projectVersion.updateMany({
          where: { id: rawAskedId },
          data: { approvalStatus: "NOT_REQUESTED" },
        }),
      ),
    ).rejects.toThrow(/PORTAL_APPROVAL|row-level security|check constraint/);
    // Rows the gate hides simply do not match: zero rows, no error.
    for (const id of [betaAskedId, offAskedId]) {
      const { count } = await asCarol((tx) =>
        tx.projectVersion.updateMany({
          where: { id },
          data: { approvalStatus: "APPROVED", approvalDecidedAt: new Date(), approvalByContactId: carol },
        }),
      );
      expect(count, id).toBe(0);
    }
    // AN ARCHIVED PROJECT'S ROW IS NOT HIDDEN BY THE POLICY — measured,
    // and pinned rather than wished away. No portal policy carries an
    // archive term (`listPortalTasks` documents the gap at length): the
    // archive is every projection's own `where`, and this slice's
    // writer restates it too, which is why the service answered
    // NOT_FOUND above. What the DATABASE guarantees for a census write
    // is exactly what `portal_gate` says — the contact's own client, a
    // SHIPPED row, the portal switch — and this row satisfies all three.
    // A decision left on an archived project is the contact's own
    // client's row and reaches no surface (the rail of an archived
    // project is empty); it is recorded here so the boundary is read
    // off the test and not assumed wider than it is.
    expect(
      (
        await asCarol((tx) =>
          tx.projectVersion.updateMany({
            where: { id: archivedAskedId },
            data: { approvalStatus: "APPROVED", approvalDecidedAt: new Date(), approvalByContactId: carol },
          }),
        )
      ).count,
    ).toBe(1);
    // POSITIVE CONTROL: the one write the census admits works, raw.
    const { count } = await asCarol((tx) =>
      tx.projectVersion.updateMany({
        where: { id: rawAskedId },
        data: { approvalStatus: "APPROVED", approvalDecidedAt: new Date(), approvalByContactId: carol },
      }),
    );
    expect(count).toBe(1);
    // …and a document's, the same three refusals and the same control.
    await expect(
      asCarol((tx) => tx.document.updateMany({ where: { id: deliverableId }, data: { name: "owned.txt" } })),
    ).rejects.toThrow(/PORTAL_COLUMNS|row-level security/);
    await expect(
      asCarol((tx) =>
        tx.document.updateMany({
          where: { id: deliverableId },
          data: { approvalStatus: "APPROVED", approvalDecidedAt: new Date(), approvalByContactId: carol, approvalVersionNumber: 7 },
        }),
      ),
    ).rejects.toThrow(/PORTAL_COLUMNS|row-level security/);
    expect(
      (
        await asCarol((tx) =>
          tx.document.updateMany({
            where: { id: internalDeliverableId },
            data: { approvalStatus: "APPROVED", approvalDecidedAt: new Date(), approvalByContactId: carol },
          }),
        )
      ).count,
    ).toBe(0);
  });

  it("approves a version: the row, the CONTACT's audit row in the same transaction, the agency's inbox row", async () => {
    const out = await decidePortalVersion(principal(carol), askedId, { decision: "APPROVED", note: null });
    expect(out).toMatchObject({ status: "APPROVED", note: null, changed: true });
    expect(out.decidedAt).toBeInstanceOf(Date);
    const row = await f.platform.projectVersion.findFirstOrThrow({ where: { id: askedId } });
    expect(row).toMatchObject({ approvalStatus: "APPROVED", approvalByContactId: carol, approvalNote: null });
    expect(row.approvalDecidedAt?.getTime()).toBe(out.decidedAt.getTime());
    // The ask it answered is kept.
    expect(row.approvalRequestedAt).not.toBeNull();

    const audits = await auditRows("project_version.approved", askedId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: "CONTACT",
      actorId: carol,
      visibility: "TENANT",
      metadata: { projectId: pOn, clientId: acme, version: SHOWN.asked },
    });
    expect(await auditRows("project_version.changes_requested", askedId)).toHaveLength(0);

    const inbox = await inboxRows(askedId);
    expect(inbox.map((n) => n.receiverId)).toEqual([f.seats.employee.memberId]);
    expect(inbox[0]).toMatchObject({
      entityType: "ProjectVersion",
      params: { subject: "version", decision: "APPROVED", projectKey: `PSG${run.slice(0, 3).toUpperCase()}` },
    });
  });

  it("a second decision on a decided row changes nothing, audits nothing, tells nobody", async () => {
    const again = await decidePortalVersion(principal(carol), askedId, {
      decision: "CHANGES_REQUESTED",
      note: "too late",
    });
    expect(again).toMatchObject({ status: "APPROVED", note: null, changed: false });
    expect(await auditRows("project_version.changes_requested", askedId)).toHaveLength(0);
    expect(await auditRows("project_version.approved", askedId)).toHaveLength(1);
    expect(await inboxRows(askedId)).toHaveLength(1);
    const row = await f.platform.projectVersion.findFirstOrThrow({ where: { id: askedId } });
    expect(row.approvalNote).toBeNull();
  });

  it("asks for changes on a deliverable, with the note, pinned to the version the ask was about", async () => {
    const out = await decidePortalDeliverable(principal(carol), deliverableId, {
      decision: "CHANGES_REQUESTED",
      note: SHOWN.note,
    });
    expect(out).toMatchObject({ status: "CHANGES_REQUESTED", note: SHOWN.note, changed: true });
    const row = await f.platform.document.findFirstOrThrow({ where: { id: deliverableId } });
    expect(row).toMatchObject({
      approvalStatus: "CHANGES_REQUESTED",
      approvalByContactId: carol,
      approvalNote: SHOWN.note,
      approvalVersionNumber: 1,
    });
    const audits = await auditRows("document.approval_decided", deliverableId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: "CONTACT",
      actorId: carol,
      metadata: { clientId: acme, projectId: pOn, decision: "CHANGES_REQUESTED", versionNumber: 1 },
    });
    // The note never travels in the audit row or the inbox row.
    expect(JSON.stringify(audits)).not.toContain(SHOWN.note);
    const inbox = await inboxRows(deliverableId);
    expect(inbox.map((n) => n.receiverId)).toEqual([f.seats.employee.memberId]);
    expect(JSON.stringify(inbox)).not.toContain(SHOWN.note);
    expect(inbox[0]).toMatchObject({ entityType: "Document", params: { subject: "deliverable", decision: "CHANGES_REQUESTED" } });
  });
});

describe("what the projections say after the decisions", () => {
  it("the rail carries the decisions as events, dated by the decision, with the client's words", async () => {
    const { entries } = await listPortalTimeline(principal(carol), { projectId: pOn });
    const decided = entries.filter((e): e is Extract<PortalTimelineEntry, { kind: "approval_decided" }> => e.kind === "approval_decided");
    // Carol's version, Carol's deliverable, and the raw positive control.
    expect(decided.map((d) => d.id).sort()).toEqual([askedId, deliverableId, rawAskedId].sort());
    const v = decided.find((d) => d.id === askedId)!;
    expect(v).toMatchObject({ subject: "version", label: SHOWN.asked, outcome: "APPROVED", note: null, versionNumber: null });
    const d = decided.find((e) => e.id === deliverableId)!;
    expect(d).toMatchObject({
      subject: "deliverable",
      label: SHOWN.deliverable,
      outcome: "CHANGES_REQUESTED",
      note: SHOWN.note,
      versionNumber: 1,
    });
    expect(Object.keys(d).sort()).toEqual(["at", "id", "kind", "label", "note", "outcome", "subject", "versionNumber"]);
    // The version's own entry now says so too, and offers nothing.
    const asked = entries.find((e) => e.kind === "version_shipped" && e.id === askedId);
    expect(asked).toMatchObject({ approval: { status: "APPROVED", canDecide: false } });
    // Still open: still offered.
    const still = entries.find((e) => e.kind === "version_shipped" && e.id === stillAskedId);
    expect(still).toMatchObject({ approval: { status: "PENDING", canDecide: true } });
    // Newest first still holds across the merged kinds.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1]!.at.getTime()).toBeGreaterThanOrEqual(entries[i]!.at.getTime());
    }
    expectNoSentinel(entries);
    // A collaborator reads the same decisions — the note is the client's, not one contact's.
    const forDan = await listPortalTimeline(principal(dan), { projectId: pOn });
    expect(forDan.entries.filter((e) => e.kind === "approval_decided").map((e) => e.id).sort()).toEqual(
      decided.map((e) => e.id).sort(),
    );
    expect(JSON.stringify(forDan)).toContain(SHOWN.note);
  });

  it("the pending lists shrink to what is still open", async () => {
    expect((await listPortalPendingVersions(principal(carol))).map((v) => v.id)).toEqual([stillAskedId]);
    expect((await listPortalPendingDeliverables(principal(carol))).map((d) => d.id)).toEqual([companyDeliverableId]);
  });

  it("Beta's decision and its note reach Beta and never Acme", async () => {
    const bos = await listPortalTimeline(principal(bo, beta), { projectId: pBeta });
    expect(JSON.stringify(bos)).toContain(S.betaNote);
    for (const projectId of [pOn]) {
      expectNoSentinel(await listPortalTimeline(principal(carol), { projectId }));
    }
    expectNoSentinel(await listPortalDocuments(principal(carol)));
  });
});

describe("a new version of a deliverable", () => {
  it("leaves a decision standing, pinned to its version, and lets staff ask again", async () => {
    await version(deliverableId, { projectId: pOn }, `second draft ${run}\n`);
    const after = await f.platform.document.findFirstOrThrow({ where: { id: deliverableId } });
    expect(after).toMatchObject({ approvalStatus: "CHANGES_REQUESTED", approvalVersionNumber: 1, approvalNote: SHOWN.note });
    // The portal says both: the newest is v2, the decision concerned v1.
    const { documents } = await listPortalDocuments(principal(carol));
    const d = documents.find((x) => x.id === deliverableId)!;
    expect(d.version.number).toBe(2);
    expect(d.approval).toMatchObject({ status: "CHANGES_REQUESTED", versionNumber: 1, canDecide: false });
    // Staff ask again, about v2; the old answer and its note go with the ask.
    const ask = await requestDocumentSignoff(ctxOf("owner"), deliverableId);
    expect(ask.versionNumber).toBe(2);
    const asked = await f.platform.document.findFirstOrThrow({ where: { id: deliverableId } });
    expect(asked).toMatchObject({
      approvalStatus: "PENDING",
      approvalVersionNumber: 2,
      approvalDecidedAt: null,
      approvalByContactId: null,
      approvalNote: null,
    });
  });

  it("voids an OPEN ask — the client must not approve bytes they never saw", async () => {
    await version(deliverableId, { projectId: pOn }, `third draft ${run}\n`);
    const row = await f.platform.document.findFirstOrThrow({ where: { id: deliverableId } });
    expect(row).toMatchObject({ approvalStatus: "NOT_REQUESTED", approvalRequestedAt: null, approvalVersionNumber: null });
    // …and the contact can no longer decide it.
    expect(
      await authzReason(decidePortalDeliverable(principal(carol), deliverableId, { decision: "APPROVED", note: null })),
    ).toBe("NOT_FOUND");
    // A standing approval of the newest version is nothing to ask about;
    // of an older one, it is.
    await requestDocumentSignoff(ctxOf("owner"), deliverableId);
    await decidePortalDeliverable(principal(carol), deliverableId, { decision: "APPROVED", note: null });
    expect(await domainCode(requestDocumentSignoff(ctxOf("owner"), deliverableId))).toBe("SIGNOFF_ALREADY_APPROVED");
    await version(deliverableId, { projectId: pOn }, `fourth draft ${run}\n`);
    expect(await domainCode(requestDocumentSignoff(ctxOf("owner"), deliverableId))).toBe("resolved");
  });

  it("a version's approval is final until re-asked, and an approved version is not re-asked", async () => {
    expect(await domainCode(requestVersionSignoff(ctxOf("owner"), askedId))).toBe("SIGNOFF_ALREADY_APPROVED");
    // Changes requested → re-asked → the client's earlier words go with the ask.
    await decidePortalVersion(principal(carol), stillAskedId, { decision: "CHANGES_REQUESTED", note: `fix ${run}` });
    expect(await domainCode(requestVersionSignoff(ctxOf("owner"), stillAskedId))).toBe("resolved");
    const row = await f.platform.projectVersion.findFirstOrThrow({ where: { id: stillAskedId } });
    expect(row).toMatchObject({ approvalStatus: "PENDING", approvalDecidedAt: null, approvalByContactId: null, approvalNote: null });
    expect(await auditRows("project_version.approval_requested", stillAskedId)).toHaveLength(2);
  });
});
