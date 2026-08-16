import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest setup/cleanup uses the raw layer */
import { getPlatformClient } from "@/db/client";
import { setupTenant } from "@/members/dbtest-fixture";

import { assignMemberToClient } from "./assignments";
import {
  archiveClient,
  createClient,
  createContact,
  deleteContact,
  getClient,
  listClients,
  unarchiveClient,
  updateClient,
  updateClientNotes,
  updateContact,
  type ClientCtx,
} from "./service";

/**
 * Clients + Contact records service against the real DB as app_runtime
 * (PLAN.md Phase 2 non-negotiable tests): deny-default scoping through
 * the service layer (employee assigned to A and B never sees C), the
 * INTERNAL-only notes path (client:edit + direct scope, audited without
 * a value), contact records (no invites), archive/restore.
 */

let t: Awaited<ReturnType<typeof setupTenant>>;
let tenantId: string;
let owner: ClientCtx;
let manager: ClientCtx;
let employee: ClientCtx;
const ids: Record<"a" | "b" | "c", string> = { a: "", b: "", c: "" };

const notFound = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ reason: "NOT_FOUND" });
const forbidden = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ reason: "FORBIDDEN" });
const domain = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toMatchObject({ name: "DomainError", code });

beforeAll(async () => {
  t = await setupTenant("clients");
  tenantId = t.tenantId;
  owner = { tenantId, actor: t.seats.owner.actor };
  manager = { tenantId, actor: t.seats.manager.actor };
  employee = { tenantId, actor: t.seats.employee.actor };
});

afterAll(async () => {
  const db = getPlatformClient();
  await db.contact.deleteMany({ where: { tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId } });
  await db.client.deleteMany({ where: { tenantId } });
  await t.cleanup();
});

describe("create + list + scoping", () => {
  it("owner creates A, B, C (audited); name is the only required field", async () => {
    ids.a = (await createClient(owner, { name: "  Acme AB ", orgNr: "556000-0001", city: "Göteborg" })).id;
    ids.b = (await createClient(owner, { name: "Beta", billingEmail: "Bill@Beta.SE" })).id;
    ids.c = (await createClient(owner, { name: "Gamma" })).id;
    await domain(createClient(owner, { name: "   " }), "NAME_REQUIRED");
    const created = await t.audits("client.created");
    expect(created.map((e) => e.targetId).sort()).toEqual([ids.a, ids.b, ids.c].sort());
    const all = await listClients(owner);
    expect(all.map((c) => c.name)).toEqual(["Acme AB", "Beta", "Gamma"]);
    expect(all.find((c) => c.id === ids.b)?.name).toBe("Beta");
    const b = await getClient(owner, ids.b);
    expect(b.billingEmail).toBe("bill@beta.se");
  });

  it("employee (no client:create) is FORBIDDEN; with zero assignments sees nothing", async () => {
    await forbidden(createClient(employee, { name: "Nope" }));
    expect(await listClients(employee)).toEqual([]);
    await notFound(getClient(employee, ids.a));
  });

  it("assigned to A and B ⇒ sees A and B, never C (list absent, get NOT_FOUND)", async () => {
    const e = t.seats.employee.memberId;
    await assignMemberToClient({ tenantId, actor: manager.actor, memberId: e, clientId: ids.a });
    await assignMemberToClient({ tenantId, actor: manager.actor, memberId: e, clientId: ids.b });
    const rows = await listClients(employee);
    expect(rows.map((c) => c.id).sort()).toEqual([ids.a, ids.b].sort());
    expect(rows.find((c) => c.id === ids.a)?.assignedMembers.map((m) => m.memberId)).toContain(e);
    const a = await getClient(employee, ids.a);
    expect(a.direct).toBe(true);
    expect(a.caps.edit).toBe(false);
    await notFound(getClient(employee, ids.c));
  });
});

describe("company card + INTERNAL-only notes", () => {
  it("client:edit writes only changed fields and audits their names", async () => {
    const r = await updateClient(owner, ids.a, { city: "Göteborg", postalCode: " 411 01 ", countryCode: "se" });
    expect(r.changed.sort()).toEqual(["countryCode", "postalCode"]);
    const again = await updateClient(owner, ids.a, { postalCode: "411 01" });
    expect(again.changed).toEqual([]);
    await domain(updateClient(owner, ids.a, { name: "" }), "NAME_REQUIRED");
    const updated = await t.audits("client.updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]?.metadata).toEqual({ fields: ["countryCode", "postalCode"] });
    const a = await getClient(owner, ids.a);
    expect(a.countryCode).toBe("SE");
  });

  it("employee (no client:edit) is FORBIDDEN on card and notes", async () => {
    await forbidden(updateClient(employee, ids.a, { city: "X" }));
    await forbidden(updateClientNotes(employee, ids.a, "secret"));
  });

  it("notes: audited as client.note_updated with NO value; hidden from non-editors", async () => {
    expect(await updateClientNotes(owner, ids.a, "Pays late; call Eva first.  ")).toEqual({ changed: true });
    expect(await updateClientNotes(owner, ids.a, "Pays late; call Eva first.")).toEqual({ changed: false });
    const notes = await t.audits("client.note_updated");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.metadata).toBeNull();
    expect((await getClient(owner, ids.a)).internalNotes).toBe("Pays late; call Eva first.");
    expect((await getClient(employee, ids.a)).internalNotes).toBeUndefined();
    // Not even the audit row carries the text.
    const raw = await getPlatformClient().auditEvent.findMany({ where: { tenantId } });
    expect(JSON.stringify(raw)).not.toContain("Pays late");
  });
});

describe("contact records (client:manage_contacts; no invites in Phase 2)", () => {
  let contactId: string;

  it("create → NO_ACCESS record, audited contact.created; email unique + validated", async () => {
    contactId = (
      await createContact(owner, ids.a, { name: "Eva Andersson", email: "Eva@Acme.SE", title: "CEO" })
    ).id;
    await domain(createContact(owner, ids.a, { name: "Dup", email: "eva@acme.se" }), "EMAIL_TAKEN");
    await domain(createContact(owner, ids.a, { name: "Bad", email: "not-an-email" }), "EMAIL_INVALID");
    await domain(createContact(owner, ids.a, { name: "", email: "x@y.se" }), "NAME_REQUIRED");
    const a = await getClient(owner, ids.a);
    expect(a.contacts).toHaveLength(1);
    expect(a.contacts[0]).toMatchObject({
      email: "eva@acme.se",
      portalStatus: "NO_ACCESS",
      portalProfile: "CONTACT_COLLABORATOR",
    });
    expect((await t.audits("contact.created")).map((e) => e.targetId)).toEqual([contactId]);
    expect((await listClients(owner)).find((c) => c.id === ids.a)?.contactCount).toBe(1);
  });

  it("employee (no client:manage_contacts) is FORBIDDEN", async () => {
    await forbidden(createContact(employee, ids.a, { name: "X", email: "x@acme.se" }));
  });

  it("update + delete are audited; delete refused once the contact has portal access", async () => {
    const r = await updateContact(owner, contactId, { title: "CTO", portalProfile: "CONTACT_PRIMARY" });
    expect(r.changed.sort()).toEqual(["portalProfile", "title"]);
    expect((await t.audits("contact.updated"))[0]?.metadata).toEqual({
      clientId: ids.a,
      fields: ["title", "portalProfile"],
    });
    await getPlatformClient().contact.update({ where: { id: contactId }, data: { portalStatus: "INVITED" } });
    await domain(deleteContact(owner, contactId), "INVALID_INPUT");
    await getPlatformClient().contact.update({ where: { id: contactId }, data: { portalStatus: "NO_ACCESS" } });
    await deleteContact(owner, contactId);
    expect((await t.audits("contact.deleted")).map((e) => e.targetId)).toEqual([contactId]);
    expect((await getClient(owner, ids.a)).contacts).toEqual([]);
  });
});

describe("archive / restore (client:delete)", () => {
  it("archive hides from the default list, blocks edits, restore brings it back — both audited", async () => {
    await forbidden(archiveClient(employee, ids.b));
    await archiveClient(owner, ids.b);
    expect((await listClients(owner)).map((c) => c.id)).not.toContain(ids.b);
    expect((await listClients(owner, { includeArchived: true })).map((c) => c.id)).toContain(ids.b);
    await domain(updateClient(owner, ids.b, { city: "X" }), "ARCHIVED");
    await domain(createContact(owner, ids.b, { name: "X", email: "x@beta.se" }), "ARCHIVED");
    await unarchiveClient(owner, ids.b);
    expect((await listClients(owner)).map((c) => c.id)).toContain(ids.b);
    expect(await t.audits("client.archived")).toHaveLength(1);
    expect(await t.audits("client.unarchived")).toHaveLength(1);
    // Unknown id ⇒ NOT_FOUND even for the owner (existence never leaks).
    await notFound(archiveClient(owner, randomUUID()));
  });
});
