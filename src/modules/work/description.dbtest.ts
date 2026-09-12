import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { setupTenant } from "@/members/dbtest-fixture";
import { createItem, deleteItem, descriptionToken, getItemDetail, updateItemDescription } from "./index";

/**
 * The description write path against the real database and the real
 * app_runtime role. The browser test cannot stand in for any of this:
 * there the panel is reached through `loadProject`, which denies first,
 * and the two things most likely to be wrong here are invisible from a
 * page — whether the compare-and-set round-trips through jsonb at all,
 * and whether the token the panel hands the editor is the token the
 * write path will accept back.
 *
 * The CAS is the reason this file exists. `updateItemDescription` reads
 * the document with Prisma, re-serialises it with `JSON.stringify`, and
 * asks Postgres whether the stored jsonb `IS NOT DISTINCT FROM` that
 * string. If Prisma's JS representation does not round-trip to a
 * jsonb-equal value — key order, number formatting, unicode escaping —
 * then EVERY second save fails as STALE_DESCRIPTION and nobody could
 * ever edit a description twice. The first two tests are that proof.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let projectId: string;

beforeAll(async () => {
  f = await setupTenant("desc");
  clientId = randomUUID();
  projectId = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Descco" } });
  await f.platform.project.create({
    data: { id: projectId, tenantId: f.tenantId, clientId, key: "DESC", name: "Desc site" },
  });
}, 60_000);

afterAll(async () => {
  const db = f.platform;
  // `tenantId` is assigned in beforeAll; if that threw, delete nothing
  // (an undefined filter is dropped and the delete becomes unfiltered).
  if (!f?.tenantId) return;
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId, parentId: { not: null } } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 60_000);

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

const doc = (...content: unknown[]) => ({ type: "doc", content });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string) => ({ type: "text", text: value });

/** A fresh task, and the token its panel would hand the editor. */
async function task(title: string): Promise<{ id: string; number: number; token: string }> {
  const { id, number } = await createItem(ownerCtx(), { projectId, title });
  const { item } = await getItemDetail(ownerCtx(), projectId, number);
  return { id, number, token: item.descriptionToken };
}

describe("updateItemDescription — the compare-and-set actually round-trips", () => {
  it("saves twice in a row, which is only possible if stored jsonb hashes and compares as the writer expects", async () => {
    const t = await task("Round trip");

    const first = await updateItemDescription(ownerCtx(), t.id, {
      doc: doc(para(text("Set up staging"))),
      baseToken: t.token,
    });

    // The token the service hands back is derived from the NORMALISED
    // document, never from a re-read. If jsonb storage were to change
    // anything about it, this second save — the one every real editing
    // session makes two seconds later — would be refused.
    const second = await updateItemDescription(ownerCtx(), t.id, {
      doc: doc(para(text("Set up staging")), para(text("Then tell the client"))),
      baseToken: first.token,
    });
    expect(second.token).not.toBe(first.token);

    // And the token a FRESH read computes must equal the one the last
    // save handed out — otherwise the next poll re-render would arm the
    // editor with a token the write path rejects.
    const { item } = await getItemDetail(ownerCtx(), projectId, t.number);
    expect(item.descriptionToken).toBe(second.token);
    expect(descriptionToken(item.description)).toBe(second.token);

    const row = await f.platform.workItem.findUniqueOrThrow({
      where: { id: t.id },
      select: { descriptionText: true, checklistTotal: true, checklistDone: true },
    });
    expect(row.descriptionText).toBe("Set up staging\nThen tell the client");
  });

  it("round-trips a document whose JSON is the awkward kind — unicode, numbers and key order", async () => {
    const t = await task("Awkward");
    // A heading carries a numeric attr, a link carries a string one, and
    // the text carries characters JSON.stringify and Postgres disagree
    // about escaping: if any of them survive storage differently from
    // the way they were hashed, the second save is refused.
    const awkward = doc(
      { type: "heading", attrs: { level: 2 }, content: [text("Rubrik — å ä ö 🙂   <tag> \"quoted\"")] },
      {
        type: "orderedList",
        attrs: { start: 3, type: "a" },
        content: [{ type: "listItem", content: [para(text("ett"))] }],
      },
      para({ type: "text", text: "länk", marks: [{ type: "link", attrs: { href: "https://example.test/a?b=1&c=2" } }] }),
    );
    const saved = await updateItemDescription(ownerCtx(), t.id, { doc: awkward, baseToken: t.token });
    const again = await updateItemDescription(ownerCtx(), t.id, {
      doc: { ...awkward, content: [...awkward.content, para(text("till"))] },
      baseToken: saved.token,
    });
    expect(again.token).not.toBe(saved.token);
    expect((await getItemDetail(ownerCtx(), projectId, t.number)).item.descriptionToken).toBe(again.token);
  });
});

describe("updateItemDescription — a stale editor is refused, never merged", () => {
  it("refuses a save whose base token is not the stored document, and leaves the stored words alone", async () => {
    const t = await task("Two editors");
    const mine = await updateItemDescription(ownerCtx(), t.id, {
      doc: doc(para(text("Mine"))),
      baseToken: t.token,
    });

    // A second editor still holding the ORIGINAL (empty) token.
    await expect(
      updateItemDescription(ownerCtx(), t.id, { doc: doc(para(text("Theirs"))), baseToken: t.token }),
    ).rejects.toThrow(/STALE_DESCRIPTION/);

    const row = await f.platform.workItem.findUniqueOrThrow({
      where: { id: t.id },
      select: { descriptionText: true },
    });
    expect(row.descriptionText).toBe("Mine"); // the refusal wrote nothing
    expect((await getItemDetail(ownerCtx(), projectId, t.number)).item.descriptionToken).toBe(mine.token);
  });

  it("two saves racing on the SAME base token: exactly one lands", async () => {
    const t = await task("Race");
    const settle = (p: Promise<unknown>) => p.then(() => "ok" as const, () => "refused" as const);
    const [a, b] = await Promise.all([
      settle(updateItemDescription(ownerCtx(), t.id, { doc: doc(para(text("A"))), baseToken: t.token })),
      settle(updateItemDescription(ownerCtx(), t.id, { doc: doc(para(text("B"))), baseToken: t.token })),
    ]);
    expect([a, b].filter((r) => r === "ok")).toHaveLength(1);

    const row = await f.platform.workItem.findUniqueOrThrow({
      where: { id: t.id },
      select: { descriptionText: true },
    });
    expect(["A", "B"]).toContain(row.descriptionText); // one whole document, never a merge
  });
});

describe("updateItemDescription — the server derives what the database stores", () => {
  it("derives text and both checklist counters, and clearing the field empties all three", async () => {
    const t = await task("Checklist");
    const saved = await updateItemDescription(ownerCtx(), t.id, {
      doc: doc({
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { checked: true }, content: [para(text("packed"))] },
          // A STRING "true" is not done — the client does not get to say.
          { type: "taskItem", attrs: { checked: "true" }, content: [para(text("claimed"))] },
          { type: "taskItem", attrs: { checked: false }, content: [para(text("open"))] },
        ],
      }),
      baseToken: t.token,
    });
    expect(saved).toMatchObject({ checklistTotal: 3, checklistDone: 1 });

    const stored = await f.platform.workItem.findUniqueOrThrow({
      where: { id: t.id },
      select: { checklistTotal: true, checklistDone: true, descriptionText: true },
    });
    expect(stored).toMatchObject({ checklistTotal: 3, checklistDone: 1 });
    expect(stored.descriptionText).toContain("packed");

    // Clearing it: the document, the text and both counters go together
    // — and the counters must land inside work_item_checklist_bounds.
    const cleared = await updateItemDescription(ownerCtx(), t.id, {
      doc: doc(para()),
      baseToken: saved.token,
    });
    expect(cleared).toMatchObject({ checklistTotal: 0, checklistDone: 0 });
    const empty = await f.platform.workItem.findUniqueOrThrow({
      where: { id: t.id },
      select: { description: true, descriptionText: true, checklistTotal: true, checklistDone: true },
    });
    expect(empty.description).toBeNull();
    expect(empty.descriptionText).toBeNull();
    expect(empty.checklistTotal).toBe(0);
  });

  it("refuses a crafted document at the seam, before it reaches a column", async () => {
    const t = await task("Crafted");
    await expect(
      updateItemDescription(ownerCtx(), t.id, {
        doc: doc({ type: "iframe", attrs: { src: "https://evil.test" } }),
        baseToken: t.token,
      }),
    ).rejects.toThrow(/INVALID_INPUT/);
    const row = await f.platform.workItem.findUniqueOrThrow({
      where: { id: t.id },
      select: { description: true },
    });
    expect(row.description).toBeNull();
  });
});

describe("updateItemDescription — the search feed finally gets a body", () => {
  it("puts description words into search_index, and takes them out again when the description is cleared", async () => {
    // The C-weight body tier has been empty for the whole build: nothing
    // ever wrote `descriptionText`. This is the slice that writes it, so
    // this is where the trigger's `UPDATE OF` list gets proven to include
    // the column (20260912120000).
    const word = `sokord${randomUUID().slice(0, 8).replace(/-/g, "")}`;
    const t = await task("Indexed");

    const hits = async (term: string): Promise<number> =>
      withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM search_index
            WHERE entity_type = 'WORK_ITEM'
              AND search @@ websearch_to_tsquery('public.fortleva_sv', $1)`,
          term,
        );
        return rows[0]?.n ?? -1;
      });

    expect(await hits(word)).toBe(0);
    const saved = await updateItemDescription(ownerCtx(), t.id, {
      doc: doc(para(text(`Detaljerna står här: ${word}`))),
      baseToken: t.token,
    });
    expect(await hits(word)).toBe(1);

    await updateItemDescription(ownerCtx(), t.id, { doc: doc(para()), baseToken: saved.token });
    expect(await hits(word)).toBe(0);
  });
});

describe("updateItemDescription — permission, scope and the rows it may not touch", () => {
  it("history coalesces to one INTERNAL row per editing session, whatever the field can be seen by", async () => {
    const t = await task("History");
    let token = t.token;
    for (const words of ["one", "one two", "one two three"]) {
      token = (await updateItemDescription(ownerCtx(), t.id, { doc: doc(para(text(words))), baseToken: token })).token;
    }
    const rows = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: t.id, field: "description" },
      select: { visibility: true },
    });
    // Three saves, one editing session — and a description is never a
    // portal-safe field, so the row the CHECK admits is INTERNAL.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.visibility).toBe("INTERNAL");
  });

  it("an out-of-scope employee is refused exactly as a stranger is, and writes nothing", async () => {
    const t = await task("Scoped");

    // Unassigned: the item-level seam denies. This is the check the
    // browser test cannot make — there `loadProject` denies first.
    await expect(
      updateItemDescription(employeeCtx(), t.id, { doc: doc(para(text("sneak"))), baseToken: t.token }),
    ).rejects.toThrow(AuthzError);
    expect(
      (await f.platform.workItem.findUniqueOrThrow({ where: { id: t.id }, select: { descriptionText: true } }))
        .descriptionText,
    ).toBeNull();

    // Positive control: the same employee, once assigned to the client,
    // may write — or the denial above proves nothing.
    await f.platform.memberClient.create({
      data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId },
    });
    const ok = await updateItemDescription(employeeCtx(), t.id, {
      doc: doc(para(text("in scope"))),
      baseToken: t.token,
    });
    expect(ok.token).not.toBe(t.token);
  });

  it("a soft-deleted item cannot be written, and answers as a number that exists nowhere", async () => {
    const t = await task("Deleted");
    await deleteItem(ownerCtx(), t.id);
    await expect(
      updateItemDescription(ownerCtx(), t.id, { doc: doc(para(text("after death"))), baseToken: t.token }),
    ).rejects.toThrow(AuthzError);
  });

  it("an item of another project is unreachable through this service", async () => {
    const otherClientId = randomUUID();
    const otherProjectId = randomUUID();
    await f.platform.client.create({ data: { id: otherClientId, tenantId: f.tenantId, name: "Other Descco" } });
    await f.platform.project.create({
      data: { id: otherProjectId, tenantId: f.tenantId, clientId: otherClientId, key: "ODSC", name: "Other desc" },
    });
    const stranger = await createItem(ownerCtx(), { projectId: otherProjectId, title: "Not the employee's" });
    const { item } = await getItemDetail(ownerCtx(), otherProjectId, stranger.number);

    await expect(
      updateItemDescription(employeeCtx(), stranger.id, {
        doc: doc(para(text("reach"))),
        baseToken: item.descriptionToken,
      }),
    ).rejects.toThrow(AuthzError);
  });
});
