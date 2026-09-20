import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest setup/cleanup uses the raw layer */
import { getPlatformClient } from "@/db/client";
import { createClient } from "@/clients/service";
import { setupTenant } from "@/members/dbtest-fixture";

import { createMilestone } from "./milestones";
import {
  createProject,
  PORTAL_LOCK_WAIT_MS,
  setPortalEnabled,
  type ProjectCtx,
} from "./service";

/**
 * The portal switch under CONTENTION (slice 43, 2026-09-20).
 *
 * `setPortalEnabled` writes one `project` row and
 * `project_portal_enabled_fanout` turns it into ten mass UPDATEs. A
 * concurrent writer holding any row on any of those ten tables makes
 * the fan-out WAIT — not cycle, so there is no deadlock for Postgres to
 * detect and no 40P01 for `retryOnDeadlock` to match. Until this slice
 * NOTHING ended that wait: `lock_timeout` and `statement_timeout` are
 * both 0 on this datasource, and Prisma's transaction budget is
 * enforced around the queries the client issues, not inside one the
 * database has parked. So the switch hung until something upstream
 * gave up, holding every lock the fan-out had already taken — on the
 * one control in this product that exists to stop a client seeing
 * internal data. (This file is the measurement of record for that, so
 * it must not repeat the older, wrong story that the wait "died as a
 * P2028 at the 5 s budget" — a review caught this very comment doing
 * exactly that.)
 *
 * These tests are the reason `isLockTimeout` may be trusted: the error
 * they assert on is a REAL 55P03 raised by a REAL blocked fan-out on
 * the installed runtime, not a synthesised object. The deadlock test
 * next door was written from Prisma's source and had to be corrected
 * twice (P2039 vs P2010, slice 37) — so this one provokes instead.
 *
 * THE BLOCKED LEG IS `milestone` because it is the first one the
 * fan-out reaches and the cheapest to set up from this module. The
 * mechanism is per-leg identical: the story that motivated the slice is
 * a bulk edit holding `work_item` rows, which is leg five.
 */

let t: Awaited<ReturnType<typeof setupTenant>>;
let tenantId: string | undefined;
let owner: ProjectCtx;
let projectId = "";
let milestoneId = "";

beforeAll(async () => {
  t = await setupTenant("portalc");
  tenantId = t.tenantId;
  owner = { tenantId, actor: t.seats.owner.actor };
  const clientId = (await createClient(owner, { name: "Blocked Co" })).id;
  projectId = (await createProject(owner, { clientId, key: "BLK", name: "Blocked" })).id;
  milestoneId = (await createMilestone(owner, { projectId, name: "Kickoff" })).id;
});

afterAll(async () => {
  // Same guard as every other dbtest: a beforeAll that threw before
  // tenantId was assigned leaves nothing to clean, and deleteMany with
  // an undefined filter silently drops it (the 2026-08-31 dev-DB wipe).
  if (tenantId === undefined) return;
  const db = getPlatformClient();
  await db.milestone.deleteMany({ where: { tenantId } });
  await db.project.deleteMany({ where: { tenantId } });
  await db.client.deleteMany({ where: { tenantId } });
  await t.cleanup();
});

/**
 * Hold a real row lock on `milestone` from a SECOND connection for as
 * long as `body` runs. The platform client is its own pool, so this is
 * a genuinely concurrent transaction and not a nested one; BYPASSRLS
 * changes what it can SEE and nothing about the locks it takes.
 *
 * `release` is resolved in a `finally` so a failing assertion inside
 * `body` cannot strand the holder until its own timeout and take the
 * rest of the file's wall clock with it.
 */
async function whileRowLocked<T>(body: (release: () => void) => Promise<T>): Promise<T> {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let locked = () => {};
  const takenLock = new Promise<void>((r) => (locked = r));

  const holder = getPlatformClient().$transaction(
    async (tx) => {
      await tx.milestone.update({ where: { id: milestoneId }, data: { name: "Held" } });
      locked();
      await held;
    },
    // Outlive every attempt the switch will make, or the holder lets
    // go mid-test and the assertion measures nothing. A flat, generous
    // ceiling rather than one derived from the budgets: those are
    // multiplied by with-tenant's LINK_FACTOR at runtime and this is
    // not, so anything computed from the raw constants is too short on
    // a widened link. Vitest's own per-test timeout fires long before
    // this does; it is here only so a stranded holder cannot outlive
    // the file.
    { timeout: 120_000, maxWait: 10_000 },
  );

  try {
    await takenLock;
    // `release` is handed to the body so a test can let go MID-call —
    // the only way to observe the retry loop actually recovering. The
    // `finally` releases again for every test that does not, and a
    // second resolve of the same promise is a no-op.
    return await body(release);
  } finally {
    release();
    await holder;
  }
}

describe("portal switch under contention", () => {
  it("a blocked fan-out is a typed PORTAL_SWITCH_BUSY, not a 500, and changes nothing", async () => {
    const db = getPlatformClient();

    const started = Date.now();
    await whileRowLocked(async () => {
      await expect(setPortalEnabled(owner, projectId, true)).rejects.toMatchObject({
        name: "DomainError",
        code: "PORTAL_SWITCH_BUSY",
      });
    });

    // It waited for the bound rather than failing instantly — one
    // whole `lock_timeout` is the least a genuine lock wait can cost,
    // so this separates "the bound fired" from "something else threw".
    // There is deliberately NO upper bound here: the constants are
    // multiplied by LINK_FACTOR at runtime and this measurement is not,
    // so any ceiling written against the raw constant fails on a
    // widened link while the code is correct — and it would be
    // redundant anyway, since a P2028 could not have produced the
    // PORTAL_SWITCH_BUSY the line above already asserted.
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(PORTAL_LOCK_WAIT_MS);

    // Nothing half-happened: the switch is off, the children are off,
    // and no audit row claims a transition. This is what makes "try
    // again" the honest message.
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.portalEnabled).toBe(false);
    const milestone = await db.milestone.findUniqueOrThrow({ where: { id: milestoneId } });
    expect(milestone.portalEnabled).toBe(false);
    expect(await t.audits("project.portal_enabled")).toHaveLength(0);
  });

  it("and it goes through once the other writer is gone", async () => {
    const db = getPlatformClient();
    expect(await setPortalEnabled(owner, projectId, true)).toEqual({ changed: true });
    const milestone = await db.milestone.findUniqueOrThrow({ where: { id: milestoneId } });
    expect(milestone.portalEnabled).toBe(true);
    expect(await t.audits("project.portal_enabled")).toHaveLength(1);
  });
});

describe("portal switch recovery", () => {
  it("a switch blocked on the first attempt still goes through when the blocker lets go", async () => {
    // THE RETRY LOOP'S WHOLE PURPOSE, and it had no test: a review
    // pointed out that setting the attempt count to 1 left both tests
    // above passing, because neither one ever needed a SECOND attempt.
    //
    // THE RELEASE DELAY IS THE WHOLE TEST, and the first draft of it
    // got the arithmetic wrong — 1.3 bounds, which still passed at one
    // attempt, because the wait does not begin until `requireAccess`
    // and `loadInScope` have made their round trips. Writing S for that
    // setup, attempt k spans [S + (k-1)·bound, S + k·bound]. So:
    //   • "an attempt definitely FAILED first" needs release > S+bound;
    //   • "an attempt was still alive to succeed" needs release < S+3·bound.
    // TWO bounds satisfies both for every S in [0, bound) — which is
    // every S this test can have — with no assumption about link speed.
    // At 1.3 the first condition needed S < 0.3·bound, and S over Neon
    // is right at that line, which is why it passed when it should not.
    //
    // (Under a widened DB_TX_TIMEOUT_MS the runtime bound scales and
    // this delay does not, so the test degrades to proving only that a
    // blocked switch still goes through — never to a false pass. CI
    // sets no factor, which is where the retry claim is earned.)
    //
    // Direction matters: this turns the portal OFF, which is the
    // safety-critical half. A switch that gave up on transient
    // contention would leave a client seeing the project.
    const db = getPlatformClient();
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).portalEnabled).toBe(true);

    const releaseAfterMs = PORTAL_LOCK_WAIT_MS * 2;
    const started = Date.now();
    const result = await whileRowLocked(async (release) => {
      setTimeout(release, releaseAfterMs);
      return setPortalEnabled(owner, projectId, false);
    });

    expect(result).toEqual({ changed: true });
    // It did not sail through: it was blocked past a whole bound and
    // still got there, which one attempt cannot do.
    expect(Date.now() - started).toBeGreaterThanOrEqual(releaseAfterMs);
    const milestone = await db.milestone.findUniqueOrThrow({ where: { id: milestoneId } });
    expect(milestone.portalEnabled).toBe(false);
    expect(await t.audits("project.portal_disabled")).toHaveLength(1);
  });
});

/**
 * The indexes migration 20260920190000 added, asserted STRUCTURALLY —
 * the columns and their ORDER, which is what decides whether the
 * fan-out's `tenant_id = … AND project_id = …` can use them at all.
 *
 * Deliberately not an EXPLAIN. A plan on a fixture-sized table says
 * more about the row count than about the schema: Postgres seq-scans a
 * handful of rows whatever indexes exist, and forcing `enable_seqscan
 * = off` would only prove the index is USABLE, which is what this
 * proves directly and without the theatre. The regression actually
 * worth catching is someone dropping the index or putting a column in
 * front of the pair.
 */
describe("portal fan-out indexes", () => {
  const leadingColumns = async (table: string, index: string): Promise<string[]> => {
    const rows = await getPlatformClient().$queryRaw<{ col: string }[]>`
      SELECT a.attname AS col
        FROM pg_class t
        JOIN pg_index i ON i.indrelid = t.oid
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       WHERE t.relname = ${table} AND c.relname = ${index}
       ORDER BY k.ord`;
    return rows.map((r) => r.col);
  };

  it("work_item_activity and service can both be reached by (tenant_id, project_id)", async () => {
    expect(
      await leadingColumns("work_item_activity", "work_item_activity_tenant_id_project_id_idx"),
    ).toEqual(["tenant_id", "project_id"]);
    expect(await leadingColumns("service", "service_tenant_id_project_id_idx")).toEqual([
      "tenant_id",
      "project_id",
    ]);
  });
});
