import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest setup/cleanup uses the raw layer */
import { getPlatformClient } from "@/db/client";
import { withTenant } from "@/db";

/**
 * THE CONTACT-WRITABLE CENSUS (TENANCY.md §7.2/§11, SECURITY.md §7,
 * AUTHZ.md §8) — stated as a property of the DATABASE, over every table
 * in the schema, at COLUMN granularity.
 *
 * It answers one question: *if a contact principal were handed a
 * transaction and told to write whatever it liked, what could it
 * write?* Everything outside the answer has to be brokered under
 * `withTenant(tenantId, {type:'system'})` after `authorizePortal()`,
 * which is where the forced columns and the audit row are stamped.
 *
 * WHY IT IS COMPUTED RATHER THAN GREPPED. The three documents above
 * agree on the set, and before migration `20260920230000` the schema
 * did not implement it — measured, not suspected. `tenant_isolation` is
 * PERMISSIVE **FOR ALL** on every class-B table and `portal_gate`'s
 * WITH CHECK only pinned the row to the contact's own client, so a
 * contact principal could INSERT, UPDATE and DELETE rows of `client`,
 * `contact`, `project`, `project_version`, `milestone`, `service`,
 * `document`, `project_time_summary` and `time_report`, and could
 * DELETE any CLIENT_VISIBLE `work_item` / `work_item_activity` (those
 * two denied INSERT and UPDATE through `portal_gate`'s WITH CHECK, but
 * a DELETE is governed by USING, and USING is the READ gate). The
 * `contact` row was the sharpest of them: a self-signup and a
 * self-promotion to CONTACT_PRIMARY, against an invariant that slice 1
 * had closed three separate ways on the AUTH path — none of which is in
 * force inside an ordinary contact transaction.
 *
 * None of it was reachable, because no application code has ever handed
 * a contact-principal transaction to a write. That is the point. RLS is
 * the last line; a last line that holds only while the application is
 * perfect is not one, and Phase 3 is the phase that starts handing
 * contacts real surfaces.
 *
 * ADDING A WRITE. Drop the `portal_no_*` policy by name in a migration,
 * add the table here with the exact commands and columns, and ship the
 * behavioural test in the SAME commit. A carve-out that a reviewer can
 * see is the whole design: the policies are named rather than folded
 * into `portal_gate`'s qual so that opening one is a visible DROP and
 * not a two-character edit inside a boolean.
 */

/**
 * `"*"` = every column of the table; an array = exactly those columns
 * (a column-level GRANT); `true` = the row may be deleted.
 *
 * MEASURED 2026-09-20 against the real schema, then pinned.
 */
const CENSUS: Readonly<
  Record<string, { INSERT?: "*" | readonly string[]; UPDATE?: "*" | readonly string[]; DELETE?: true }>
> = {
  // Portal actions are audited, and the audit row is written in the
  // same transaction as the action (SECURITY.md §7). Append-only: the
  // runtime role holds no UPDATE or DELETE on this table at all, and
  // `audit_portal_select_deny` means a contact cannot read back what it
  // wrote.
  audit_event: { INSERT: "*" },
  // THE one contact-writable content row. `portal_gate`'s WITH CHECK
  // spells the whole predicate out: CLIENT_VISIBLE, the contact's own
  // client, `author_contact_id = app.principal_id`, portal-enabled.
  // UPDATE and DELETE are denied outright (`portal_no_update` /
  // `portal_no_delete`) — a contact cannot edit or retract in v1.
  comment: { INSERT: "*" },
  // The inbox flags on the contact's OWN receiver rows, bound by
  // `principal_scope_update`. A column GRANT, which is the mechanism to
  // reach for when NO principal may write the other columns: it cannot
  // distinguish a member from a contact (both are `app_runtime`), so a
  // per-principal column rule still needs a trigger. `snoozed_till` is
  // granted alongside the two columns the documents name — a drift in
  // the docs, not in the schema.
  notification: { UPDATE: ["archived_at", "read_at", "snoozed_till"] },
  // NOT a census entry in the principal sense: the feed trigger that
  // fires underneath the one permitted contact INSERT (the comment)
  // writes here, under the contact's own principal. `search_upsert` is
  // `INSERT … ON CONFLICT DO UPDATE`, so that path needs both verbs —
  // but only for `entity_type = 'COMMENT'`, which migration
  // `20260921000000` now pins, and it never DELETEs (the delete branch
  // of `search_feed_comment` fires on a comment DELETE or soft-delete,
  // neither of which a contact can perform), so DELETE is closed.
  search_index: { INSERT: "*", UPDATE: "*" },
};

/**
 * THE THREE REMAINING INSERT/UPDATE ENTRIES ARE OPEN *UNDER A
 * PREDICATE*, AND THIS TABLE CANNOT SEE THE PREDICATE. The computation
 * below answers "may a contact write this column at all", which is the
 * right question for a tripwire and the wrong one to read as
 * "unconstrained". Each is narrowed by a RESTRICTIVE policy whose
 * predicate contains an OR — deliberately not counted as a deny, because
 * counting OR-forms would make the tripwire's failure direction unsafe:
 *
 *   comment       INSERT — CLIENT_VISIBLE, own client, authored as
 *                          self, portal-enabled (`portal_gate`)
 *   audit_event   INSERT — actor_type = 'CONTACT', actor_id =
 *                          app.principal_id, visibility = 'TENANT'
 *                          (`portal_audit_insert`)
 *   search_index  I/U    — entity_type = 'COMMENT'
 *                          (`portal_comment_rows_only*`)
 *
 * The behavioural tests below drive each predicate; the pin above only
 * guarantees that no NEW verb or column has opened.
 */

/**
 * A RESTRICTIVE policy that shuts contacts out of a command entirely,
 * as opposed to one that lets them in under conditions. The test is
 * deliberately strict rather than clever — "mentions the contact
 * comparison and contains no OR" — so that a deny written some other
 * way is reported as NOT a deny and somebody looks at it. The failure
 * direction of a heuristic in a security test matters more than its
 * precision.
 */
const isOutrightContactDeny = (expr: string | null): boolean =>
  !!expr && expr.includes("IS DISTINCT FROM 'contact'") && !/\bOR\b/.test(expr);

type PolicyRow = {
  tablename: string;
  policyname: string;
  permissive: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
};

describe("the contact-writable census is exactly what the documents say", () => {
  it("across every table in the schema, at column granularity", async () => {
    const db = getPlatformClient();
    const policies = await db.$queryRaw<PolicyRow[]>`
      SELECT tablename, policyname, permissive, cmd, qual, with_check
        FROM pg_policies WHERE schemaname = 'public'`;
    // Table-level privilege: "every column". `rls` carries whether the
    // table has RLS enabled AND forced at all — without it the census
    // has a false NEGATIVE (security review, 2026-09-20): a table with
    // grants and no `ENABLE ROW LEVEL SECURITY` has no `pg_policies`
    // rows, so the loop below would skip it as "nobody may do it" while
    // it stood wide open to every principal. `isolation.dbtest.ts`
    // covers that in depth for registered Prisma models; this makes the
    // census self-sufficient for raw-SQL tables too (`search_index` is
    // one).
    const tablePriv = await db.$queryRaw<
      { t: string; pt: string; granted: boolean; rls: boolean }[]
    >`
      SELECT c.relname AS t, p.pt, has_table_privilege('app_runtime', c.oid, p.pt) AS granted,
             (c.relrowsecurity AND c.relforcerowsecurity) AS rls
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL (VALUES ('INSERT'), ('UPDATE'), ('DELETE')) AS p(pt)
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE '\\_prisma%'`;
    // Column-level privilege, which `has_table_privilege` reports as
    // FALSE — the distinction `notification` depends on.
    const columnPriv = await db.$queryRaw<{ t: string; pt: string; col: string }[]>`
      SELECT c.relname AS t, p.pt, a.attname AS col
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        CROSS JOIN LATERAL (VALUES ('INSERT'), ('UPDATE')) AS p(pt)
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE '\\_prisma%'
         AND has_column_privilege('app_runtime', c.oid, a.attname, p.pt)`;

    const wholeTable = new Map(tablePriv.map((r) => [`${r.t}|${r.pt}`, r.granted]));
    const columns = new Map<string, string[]>();
    for (const r of columnPriv) {
      const key = `${r.t}|${r.pt}`;
      columns.set(key, [...(columns.get(key) ?? []), r.col]);
    }

    const writable: Record<string, Record<string, unknown>> = {};
    for (const table of [...new Set(tablePriv.map((r) => r.t))].sort()) {
      const mine = policies.filter((p) => p.tablename === table);
      const entry: Record<string, unknown> = {};
      // A table without RLS enabled+forced is open to everything it is
      // granted — no policy is consulted at all.
      const unprotected = tablePriv.some((r) => r.t === table && !r.rls);
      for (const cmd of ["INSERT", "UPDATE", "DELETE"] as const) {
        // Nothing PERMISSIVE covering the command ⇒ nobody may do it,
        // UNLESS the table is not protected in the first place.
        if (
          !unprotected &&
          !mine.some((p) => p.permissive === "PERMISSIVE" && (p.cmd === cmd || p.cmd === "ALL"))
        ) {
          continue;
        }
        const denied = !unprotected && mine
          .filter((p) => p.permissive === "RESTRICTIVE" && (p.cmd === cmd || p.cmd === "ALL"))
          // DELETE has no WITH CHECK; INSERT has no USING. Checking both
          // for UPDATE is deliberate — `work_item` denies it through the
          // WITH CHECK half of `portal_gate`, not through a USING.
          .some((p) =>
            cmd === "DELETE"
              ? isOutrightContactDeny(p.qual)
              : isOutrightContactDeny(p.qual) || isOutrightContactDeny(p.with_check),
          );
        if (denied) continue;
        if (cmd === "DELETE") {
          if (wholeTable.get(`${table}|DELETE`)) entry[cmd] = true;
          continue;
        }
        if (wholeTable.get(`${table}|${cmd}`)) entry[cmd] = "*";
        else {
          const cols = columns.get(`${table}|${cmd}`);
          if (cols?.length) entry[cmd] = [...cols].sort();
        }
      }
      if (Object.keys(entry).length > 0) writable[table] = entry;
    }

    expect(writable).toEqual(CENSUS);
  });
});

// ── The behavioural half: the closures, under a real contact ────────
//
// The structural test above reads policies; this one drives them. Both
// are needed and neither implies the other — a policy can be present and
// wrong, and a write can fail for a reason that has nothing to do with
// RLS (which is what the positive control at the end rules out).

const run = randomUUID().slice(0, 8);
const T = randomUUID();
const clientId = randomUUID();
const projectId = randomUUID();
const contactId = randomUUID();
const stateId = randomUUID();
const itemId = randomUUID();

const asContact = <T2,>(fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T2>) =>
  withTenant(T, { type: "contact", id: contactId, clientId }, fn);

describe("a contact principal cannot write outside the census", () => {
  beforeAll(async () => {
    const db = getPlatformClient();
    await db.tenant.create({
      data: { id: T, name: `census-${run}`, slug: `census-${run}`, entitlements: {} },
    });
    await db.client.create({ data: { id: clientId, tenantId: T, name: "Acme" } });
    await db.project.create({
      data: { id: projectId, tenantId: T, clientId, key: "CEN", name: "Portal on", portalEnabled: true },
    });
    await db.contact.create({
      data: {
        id: contactId,
        tenantId: T,
        clientId,
        name: "Client Carol",
        email: `census-${run}@test.invalid`,
        portalProfile: "CONTACT_COLLABORATOR",
        portalStatus: "ACTIVE",
        invitedAt: new Date("2026-09-01T09:00:00Z"),
      },
    });
    await db.workflowState.create({
      data: { id: stateId, tenantId: T, projectId, name: "To do", category: "TODO", rank: "a0", isDefault: true },
    });
    await db.workItem.create({
      data: {
        id: itemId,
        tenantId: T,
        clientId,
        projectId,
        number: 1,
        title: "Shared task",
        stateId,
        stateCategory: "TODO",
        rootId: itemId,
        rank: "a0",
        visibility: "CLIENT_VISIBLE",
      },
    });
    await db.milestone.create({
      data: { tenantId: T, clientId, projectId, name: "Shared", rank: "a0", visibility: "CLIENT_VISIBLE" },
    });
  });

  afterAll(async () => {
    const db = getPlatformClient();
    await db.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${T}`;
    await db.comment.deleteMany({ where: { tenantId: T } });
    await db.workItemActivity.deleteMany({ where: { tenantId: T } });
    await db.workItem.deleteMany({ where: { tenantId: T } });
    await db.workflowState.deleteMany({ where: { tenantId: T } });
    await db.milestone.deleteMany({ where: { tenantId: T } });
    await db.contact.deleteMany({ where: { tenantId: T } });
    await db.project.deleteMany({ where: { tenantId: T } });
    await db.client.deleteMany({ where: { tenantId: T } });
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
      await tx.auditEvent.deleteMany({ where: { tenantId: T } });
    });
    await db.tenant.delete({ where: { id: T } });
  });

  it("cannot INSERT a contact — self-signup, at the data layer", async () => {
    // The invariant slice 1 closed three ways on the auth path
    // (`disableSignUp`, the `portalAuthClient` refusal, and no INSERT
    // policy for the auth-path GUC). None of those three is in force
    // here, which is exactly why this needed its own no.
    await expect(
      asContact((tx) =>
        tx.contact.create({
          data: {
            tenantId: T,
            clientId,
            name: "Smuggled colleague",
            email: `smuggled-${run}@test.invalid`,
            portalProfile: "CONTACT_PRIMARY",
            portalStatus: "ACTIVE",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
    expect(
      await getPlatformClient().contact.count({ where: { tenantId: T } }),
    ).toBe(1);
  });

  it("cannot promote ITSELF to CONTACT_PRIMARY", async () => {
    // `contact_auth_path_immutable` does not cover this: that trigger
    // keys on `app.auth_contact_id`, which only src/db/portal-identity.ts
    // sets. `portal_no_update` is a WITH CHECK deny (migration
    // 20260920233000 — a USING deny would also make the row unlockable),
    // so the row matches and the NEW row is refused: 42501, not a silent
    // zero-row update.
    await expect(
      asContact((tx) =>
        tx.contact.updateMany({
          where: { id: contactId },
          data: { portalProfile: "CONTACT_PRIMARY" },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
    const after = await getPlatformClient().contact.findFirst({ where: { id: contactId } });
    expect(after?.portalProfile).toBe("CONTACT_COLLABORATOR");
  });

  it("cannot DELETE itself, its client, or its project", async () => {
    const deleted = await asContact(async (tx) => ({
      contacts: (await tx.contact.deleteMany({ where: { id: contactId } })).count,
      clients: (await tx.client.deleteMany({ where: { id: clientId } })).count,
      projects: (await tx.project.deleteMany({ where: { id: projectId } })).count,
    }));
    expect(deleted).toEqual({ contacts: 0, clients: 0, projects: 0 });
  });

  it("cannot rename its client or flip its project's portal switch", async () => {
    await expect(
      asContact((tx) => tx.client.updateMany({ where: { id: clientId }, data: { name: "Owned" } })),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      asContact((tx) =>
        tx.project.updateMany({ where: { id: projectId }, data: { portalEnabled: false } }),
      ),
    ).rejects.toThrow(/row-level security/i);
    const db = getPlatformClient();
    expect((await db.client.findFirst({ where: { id: clientId } }))?.name).toBe("Acme");
    expect((await db.project.findFirst({ where: { id: projectId } }))?.portalEnabled).toBe(true);
  });

  it("cannot DELETE a client-visible work item or its activity", async () => {
    // The hole `portal_gate` could not close: its WITH CHECK denies
    // INSERT and UPDATE, but a DELETE is decided by USING alone — and
    // USING is the READ gate, which admits every row a contact can see.
    const deleted = await asContact(async (tx) => ({
      items: (await tx.workItem.deleteMany({ where: { id: itemId } })).count,
      activity: (await tx.workItemActivity.deleteMany({ where: { workItemId: itemId } })).count,
    }));
    expect(deleted).toEqual({ items: 0, activity: 0 });
    expect(await getPlatformClient().workItem.count({ where: { id: itemId } })).toBe(1);
  });

  it("cannot INSERT a document, a milestone or a work item", async () => {
    // The three TENANCY.md §11 names explicitly: "Any other success —
    // notably Document INSERT, FileVersion, FileObject, WorkItem (any
    // kind) … fails the build."
    await expect(
      asContact((tx) =>
        tx.document.create({
          data: { tenantId: T, clientId, projectId, name: "planted.pdf", visibility: "CLIENT_VISIBLE" },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      asContact((tx) =>
        tx.milestone.create({
          data: { tenantId: T, clientId, projectId, name: "Planted", rank: "b0", visibility: "CLIENT_VISIBLE" },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
    // The work item is refused TWICE over, and the first no arrives
    // before RLS gets a turn: the BEFORE INSERT state guard reads
    // `workflow_state`, which is class A (portal_deny), so under a
    // contact principal the state is invisible and the guard raises
    // `state does not belong to the item's project`. The RLS WITH CHECK
    // is the second no. Asserted as "refused, and nothing was written"
    // rather than on a message, because which of the two fires is an
    // implementation detail of the trigger order.
    await expect(
      asContact((tx) => {
        const id = randomUUID();
        return tx.workItem.create({
          data: {
            id,
            tenantId: T,
            clientId,
            projectId,
            number: 2,
            title: "Planted request",
            stateId,
            stateCategory: "TODO",
            rootId: id,
            rank: "b0",
            visibility: "CLIENT_VISIBLE",
          },
        });
      }),
    ).rejects.toThrow();
    expect(await getPlatformClient().workItem.count({ where: { tenantId: T } })).toBe(1);
  });

  it("cannot DELETE from the tenant's staff search index", async () => {
    // `search_index` is not a Prisma model, so this is raw SQL under a
    // contact transaction — the same standard every other closure here
    // was held to. Before migration 20260921000000 this DELETE would
    // have emptied every client-visible row of the tenant's OWN staff
    // search: members read the same table.
    const before = await getPlatformClient().$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM search_index WHERE tenant_id = ${T}`;
    // Non-vacuity: "0 rows deleted" proves nothing if there was nothing
    // to delete. The fixture's CLIENT_VISIBLE work item and milestone
    // feed the index, so this is a real target.
    expect(before[0]?.n ?? 0).toBeGreaterThan(0);
    const deleted = await asContact(
      (tx) => tx.$executeRaw`DELETE FROM search_index WHERE client_id = ${clientId}`,
    );
    expect(deleted).toBe(0);
    const after = await getPlatformClient().$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM search_index WHERE tenant_id = ${T}`;
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it("cannot plant a non-COMMENT row in the search index", async () => {
    // `portal_gate` on search_index binds client, visibility and
    // portal_enabled and NOTHING else — not entity_type, not the text.
    // The contact-caused feed writes exactly one entity type.
    await expect(
      asContact(
        (tx) => tx.$executeRaw`
          INSERT INTO search_index (tenant_id, entity_type, entity_id, client_id, project_id,
                                    visibility, portal_enabled, title, body_text, lang, updated_at)
          VALUES (${T}, 'DOCUMENT', ${randomUUID()}, ${clientId}, ${projectId},
                  'CLIENT_VISIBLE', true, 'planted', 'planted', 'fortleva_en', now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  // NOTE: `audit_event.id` has no database default — Prisma mints it
  // client-side — so every raw insert below supplies one. Without it a
  // refusal could be a NOT NULL violation wearing an RLS refusal's
  // clothes, and the negative tests would measure nothing.
  it("cannot forge an audit row attributed to a MEMBER", async () => {
    // Write-only evidence poisoning, in the one table SECURITY.md §7
    // treats as evidentiary: `audit_tenant_insert` pinned the tenant and
    // nothing else, and `audit_event_immutable` makes every row
    // permanent. A contact could therefore append a staff action it
    // could not read back and nobody could remove.
    await expect(
      asContact(
        (tx) => tx.$executeRaw`
          INSERT INTO audit_event (id, tenant_id, actor_type, actor_id, action, visibility)
          VALUES (gen_random_uuid()::text, ${T}, 'MEMBER', ${randomUUID()}, 'client.deleted', 'TENANT')`,
      ),
    ).rejects.toThrow(/row-level security/i);
    // …nor one attributed to a DIFFERENT contact, nor a PLATFORM row.
    await expect(
      asContact(
        (tx) => tx.$executeRaw`
          INSERT INTO audit_event (id, tenant_id, actor_type, actor_id, action, visibility)
          VALUES (gen_random_uuid()::text, ${T}, 'CONTACT', ${randomUUID()}, 'client.deleted', 'TENANT')`,
      ),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      asContact(
        (tx) => tx.$executeRaw`
          INSERT INTO audit_event (id, tenant_id, actor_type, actor_id, action, visibility)
          VALUES (gen_random_uuid()::text, ${T}, 'CONTACT', ${contactId}, 'client.deleted', 'PLATFORM')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("POSITIVE CONTROL: an audit row describing ITSELF is still permitted", async () => {
    // The narrowing must not close the path `audit.record()` already
    // produces under a contact principal (it derives actorType CONTACT
    // and actorId from the principal), or the first brokered portal
    // action would be unauditable.
    const written = await asContact(
      (tx) => tx.$executeRaw`
        INSERT INTO audit_event (id, tenant_id, actor_type, actor_id, action, visibility)
        VALUES (gen_random_uuid()::text, ${T}, 'CONTACT', ${contactId}, 'client.deleted', 'TENANT')`,
    );
    expect(written).toBe(1);
  });

  it("POSITIVE CONTROL: the one permitted write still works", async () => {
    // Without this, every assertion above could be passing because
    // contact writes are broken for some unrelated reason — a revoked
    // grant, a missing GUC, a fixture that never had the rows. The
    // census is only meaningful if the census entry itself is live.
    const comment = await asContact((tx) =>
      tx.comment.create({
        data: {
          tenantId: T,
          subjectType: "WORK_ITEM",
          subjectId: itemId,
          authorContactId: contactId,
          body: {},
          bodyText: "Tack, ser bra ut!",
          visibility: "CLIENT_VISIBLE",
        },
      }),
    );
    expect(comment.clientId).toBe(clientId);
    expect(comment.portalEnabled).toBe(true);
  });
});
