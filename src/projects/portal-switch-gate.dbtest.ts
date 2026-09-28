import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  lockTimeoutSetting,
  PORTAL_ENABLED_FANOUT_TARGETS,
  RLS_CLASSES,
  tableNameOf,
  withTenant,
  type TenantDb,
} from "@/db";
import { setupTenant } from "@/members/dbtest-fixture";
import { recomputeProjectMonth } from "@/modules/time";
import { describeError, settle } from "@/modules/work/dbtest-locks";

import { PORTAL_LOCK_WAIT_MS, setPortalEnabled, type ProjectCtx } from "./service";

/**
 * THE PORTAL SWITCH GATE against the real schema and the real
 * `app_runtime` role (Phase 3 slice 74, OPEN_QUESTIONS C40; migration
 * 20260928180000_portal_switch_gate, whose header is the argument these
 * cases measure).
 *
 * THE RACE. A child row's `portal_enabled` is a COPY of its project's
 * switch, stamped at INSERT by a lock-free read. A row written by a
 * transaction still open when a DISABLE's fan-out took its snapshot was
 * invisible to every leg and kept `true` after the portal was off. Now
 * every stamp TRIES the project's gate G (an advisory key) SHARED and the
 * switch holds it EXCLUSIVE: a stamp that gets it makes the switch wait
 * for its write; one that does not writes `false` (fail closed),
 * registers in doubt on a second key D and arms a commit-time heal; and a
 * reconcile after every gated switch re-derives what is left.
 *
 * WHAT THE GROUPS PROVE — and every case says, as "HEAD:", what the code
 * before this slice does at the assertion that fails on it:
 *   · a stamp NEVER WAITS: it holds the gate, or fails closed at once;
 *   · the DATABASE enforces the gate on any flip, and the premises the
 *     proof rests on (READ COMMITTED, the no-xid rule) are checked;
 *   · `setPortalEnabled` decides UNDER the gate — it waits for writes in
 *     flight, orders two presses, and ends BUSY having written nothing;
 *   · LIVENESS: a row that failed closed comes back — healed at its own
 *     commit, or reconciled (after the in-doubt writers have ended, and
 *     again on a later pass if a row was held) — and the reconcile never
 *     waits on a row;
 *   · SAFETY at the edges: the reconcile cannot write a stale TRUE across
 *     a DISABLE, the fan-out's own stamps are granted the gate with a
 *     second switch queued, a contact's comment mid-switch is refused, and
 *     a readable row found on a switched-off project is corrected and
 *     recorded as `project.portal_stamp_alarm`.
 *
 * HOW IT IS BUILT, and why (the slice's test critique):
 *   · VEHICLES ARE RAW INSERTS in a shape the contact COULD read —
 *     CLIENT_VISIBLE on the contact's client, a SHIPPED version, a
 *     PUBLISHED report and update, hours shared for the summary — because
 *     a default-shaped row reads 0 for a contact whatever its flag says.
 *     Each asserts `RETURNING portal_enabled`, the stamp's own verdict.
 *     None takes a row lock: a service's bottom-rank FOR UPDATE or a
 *     comment's FOR SHARE on its subject would serialise it with the
 *     fan-out and prove nothing, so the comment appears only where that
 *     FOR SHARE is the point (the no-cycle case).
 *   · PROBES READ pg_locks SCOPED to this database, the mode, the grant
 *     and BOTH halves of the key, derived INLINE from `hashtextextended`
 *     rather than through the migration's helpers — so on the old schema
 *     a probe fails as "the race was not exercised", not as a missing
 *     function (isolation.dbtest.ts pins that the two derivations agree).
 *     Every probe races the call it watches, so a call that does not wait
 *     fails at once instead of after ten seconds.
 *   · HOLDERS FLIP WITH A RAW UPDATE: the fan-out's own try takes G
 *     exclusive — the lock `portal_switch_begin` would have taken first —
 *     so a holder needs no new function and runs on the old schema up to
 *     the assertion that separates the two. `portal_switch_begin` itself
 *     is driven where it is the subject (the queued switch, the early
 *     grant, the premises).
 *   · A FRESH client, contact and project per case: the reconcile's
 *     counts are project-wide, and a straggler left by one case would be
 *     the next case's arithmetic.
 *
 * Tenant slugs come from `setupTenant("pstamp")`, and the prefix
 * `pstamp-` is registered in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts)
 * so `sweep-dbtests` can collect this suite's orphans. `e2e-` is the
 * BROWSER harness's prefix and is swept by AGE — a dbtest using it would
 * have its fixtures deleted mid-run by a concurrent e2e run.
 */

/** The gate's seed and the in-doubt key's (the migration's §1). */
const G = 7401;
const D = 7402;

/** How long a probe watches before it calls the race unexercised. */
const PROBE_MS = 10_000;
/** A held transaction's Prisma budget — longer than any wait it outlives (withTenant scales it by the link factor). */
const HOLD_MS = 60_000;
/** A case that sits out every attempt of a switch (3 × PORTAL_LOCK_WAIT_MS × the link factor) or builds many rows. */
const LONG = 90_000;

let f: Awaited<ReturnType<typeof setupTenant>>;
let tenantId: string | undefined;

type ProjectFx = {
  readonly clientId: string;
  readonly projectId: string;
  readonly stateId: string;
  /** A committed CLIENT_VISIBLE root task: the contact-visible sibling, and the subject of history rows and comments. */
  readonly anchorId: string;
  /** A probe word in the anchor's title. */
  readonly anchorWord: string;
};
/** This case's client, its contact, and its project — portal ON, hours shared. */
let fx: ProjectFx & { readonly contactId: string };

type Principal = Parameters<typeof withTenant>[1];
const T = (): string => {
  if (tenantId === undefined) throw new Error("the fixture tenant was never created");
  return tenantId;
};
const member = (): Principal => ({ type: "member", id: f.seats.owner.memberId });
const system = (): Principal => ({ type: "system" });
const contact = (): Principal => ({ type: "contact", id: fx.contactId, clientId: fx.clientId });
const owner = (): ProjectCtx => ({ tenantId: T(), actor: f.seats.owner.actor });

let seq = 0;
const next = (): number => ++seq;
/** A VALID fractional key sorting before every generated one (tree-guards.dbtest.ts): a raw row is never a project's bottom row. */
const rank = (): string => `Zz${randomUUID().replace(/-/g, "")}1`;
/** Letters + digits: a `numword` token every text-search config passes through unstemmed (tree-guards.dbtest.ts). */
const word = (stem: string): string => `${stem}${randomUUID().replace(/-/g, "").slice(0, 8)}7`;
/** A month no summary row of this file has used yet — so the summary's INSERT … ON CONFLICT is an INSERT. */
const newMonth = (): string => {
  const n = next();
  return `${2000 + Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}-01`;
};
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Fixture ───────────────────────────────────────────────────────────

beforeAll(async () => {
  f = await setupTenant("pstamp");
  tenantId = f.tenantId;
});

beforeEach(async () => {
  const clientId = randomUUID();
  const contactId = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: T(), name: `Gateco ${next()}` }, select: { id: true } });
  await f.platform.contact.create({
    data: {
      id: contactId,
      tenantId: T(),
      clientId,
      name: "Client Greta",
      email: `pstamp-greta-${randomUUID().slice(0, 8)}@test.invalid`,
    },
    select: { id: true },
  });
  fx = { ...(await addProject(clientId, true)), contactId };
});

afterAll(async () => {
  // A beforeAll that threw leaves no tenant, and Prisma DROPS an
  // undefined where-filter: every delete below would be unscoped (the
  // 2026-08-31 dev-database wipe).
  if (tenantId === undefined) return;
  const where = { tenantId };
  await f.platform.$transaction(
    async (tx) => {
      // A PUBLISHED report or update refuses DELETE outside maintenance.
      await tx.$executeRaw`SELECT set_config('app.time_maintenance', 'on', true)`;
      await tx.$executeRaw`SELECT set_config('app.work_maintenance', 'on', true)`;
      await tx.projectUpdate.deleteMany({ where });
      await tx.timeReport.deleteMany({ where });
      await tx.projectTimeSummary.deleteMany({ where });
      await tx.comment.deleteMany({ where });
      await tx.workItemActivity.deleteMany({ where });
      await tx.workItem.deleteMany({ where }); // every raw item here is a root
      await tx.workflowState.deleteMany({ where });
      await tx.document.deleteMany({ where });
      await tx.service.deleteMany({ where });
      await tx.milestone.deleteMany({ where });
      await tx.projectVersion.deleteMany({ where });
      await tx.project.deleteMany({ where });
      await tx.contact.deleteMany({ where });
      await tx.client.deleteMany({ where });
      await tx.tenantCounter.deleteMany({ where });
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  await f.cleanup();
}, LONG);

/** A project of `clientId` with one default state and its anchor task. Hours are shared, so a summary row is the contact's. */
async function addProject(clientId: string, portalEnabled: boolean): Promise<ProjectFx> {
  const projectId = randomUUID();
  const n = next();
  await f.platform.project.create({
    data: { id: projectId, tenantId: T(), clientId, key: `PS${n}`, name: `Gate ${n}`, portalEnabled, hoursSharingMode: "HOURS" },
    select: { id: true },
  });
  const stateId = randomUUID();
  await f.platform.workflowState.create({
    data: { id: stateId, tenantId: T(), projectId, name: "To do", category: "TODO", rank: "a0", isDefault: true },
    select: { id: true },
  });
  const anchorWord = word("anchor");
  const unanchored = { clientId, projectId, stateId, anchorId: "", anchorWord };
  const anchor = await withTenant(T(), member(), (tx) => insertTask(tx, unanchored, `Anchor ${anchorWord}`));
  return { ...unanchored, anchorId: anchor.id };
}

// ── Vehicles: raw, lock-free, contact-visible inserts ─────────────────

type Stamped = { readonly id: string; readonly portalEnabled: boolean };
type Row = { id: string; portal_enabled: boolean };

/** Anything that runs a tagged raw query: a tenant transaction, or the platform client for one autocommit statement. */
type Raw = { $queryRaw<R = unknown>(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<R> };

async function stamped(query: PromiseLike<Row[]>): Promise<Stamped> {
  const [row] = await query;
  if (!row) throw new Error("the write returned no row");
  return { id: row.id, portalEnabled: row.portal_enabled };
}

/**
 * A ROOT task — the parent guard's root branch takes no lock and the
 * state sync is a plain read — with a fixed counter number, so no
 * counter row is involved either.
 */
function insertTask(db: Raw, p: Pick<ProjectFx, "clientId" | "projectId" | "stateId">, title: string): Promise<Stamped> {
  const id = randomUUID();
  return stamped(db.$queryRaw<Row[]>`
    INSERT INTO work_item (id, tenant_id, client_id, project_id, number, title, state_id, state_category,
                           root_id, rank, visibility, created_by_member_id, updated_at)
    VALUES (${id}, ${T()}, ${p.clientId}, ${p.projectId}, ${next()}, ${title}, ${p.stateId}, 'TODO',
            ${id}, ${rank()}, 'CLIENT_VISIBLE', ${f.seats.owner.memberId}, now())
    RETURNING id, portal_enabled`);
}

/** A comment on the anchor. NOT lock-free: `comment_denorm_guard` share-locks the subject — which is why only the no-cycle case and the contact case use it. */
function insertComment(tx: TenantDb, p: ProjectFx, by: { memberId: string } | { contactId: string }): Promise<Stamped> {
  const memberId = "memberId" in by ? by.memberId : null;
  const contactId = "contactId" in by ? by.contactId : null;
  return stamped(tx.$queryRaw<Row[]>`
    INSERT INTO comment (id, tenant_id, subject_type, subject_id, author_member_id, author_contact_id,
                         body, body_text, visibility, updated_at)
    VALUES (${randomUUID()}, ${T()}, 'WORK_ITEM', ${p.anchorId}, ${memberId}, ${contactId},
            '{}'::jsonb, ${`Comment ${next()}`}, 'CLIENT_VISIBLE', now())
    RETURNING id, portal_enabled`);
}

type Vehicle = {
  readonly table: string;
  /** Its search_index entity type, where a feed indexes it. */
  readonly indexed?: "WORK_ITEM" | "DOCUMENT";
  readonly insert: (tx: TenantDb, p: ProjectFx) => Promise<Stamped>;
};

const MILESTONE: Vehicle = {
  table: "milestone",
  insert: (tx, p) =>
    stamped(tx.$queryRaw<Row[]>`
      INSERT INTO milestone (id, tenant_id, client_id, project_id, name, rank, visibility, updated_at)
      VALUES (${randomUUID()}, ${T()}, ${p.clientId}, ${p.projectId}, ${`Milestone ${next()}`}, ${rank()},
              'CLIENT_VISIBLE', now())
      RETURNING id, portal_enabled`),
};
const VERSION: Vehicle = {
  table: "project_version",
  insert: (tx, p) =>
    stamped(tx.$queryRaw<Row[]>`
      INSERT INTO project_version (id, tenant_id, client_id, project_id, version, status, shipped_at, updated_at)
      VALUES (${randomUUID()}, ${T()}, ${p.clientId}, ${p.projectId}, ${`1.${next()}`}, 'SHIPPED', now(), now())
      RETURNING id, portal_enabled`),
};
const SERVICE: Vehicle = {
  table: "service",
  insert: (tx, p) =>
    stamped(tx.$queryRaw<Row[]>`
      INSERT INTO service (id, tenant_id, client_id, project_id, name, kind, billing_interval, visibility, updated_at)
      VALUES (${randomUUID()}, ${T()}, ${p.clientId}, ${p.projectId}, ${`Hosting ${next()}`}, 'RECURRING', 'MONTHLY',
              'CLIENT_VISIBLE', now())
      RETURNING id, portal_enabled`),
};
/** UNANCHORED: the anchor guard takes its FOR SHARE only for a document attached to a task. */
const DOCUMENT: Vehicle = {
  table: "document",
  indexed: "DOCUMENT",
  insert: (tx, p) =>
    stamped(tx.$queryRaw<Row[]>`
      INSERT INTO document (id, tenant_id, client_id, project_id, name, visibility, updated_at)
      VALUES (${randomUUID()}, ${T()}, ${p.clientId}, ${p.projectId}, ${`Brief ${next()}.pdf`}, 'CLIENT_VISIBLE', now())
      RETURNING id, portal_enabled`),
};
const TASK: Vehicle = {
  table: "work_item",
  indexed: "WORK_ITEM",
  insert: (tx, p) => insertTask(tx, p, `Task ${word("task")}`),
};
/** On the anchor: its denorm guard is a plain read, and the FK's KEY SHARE never conflicts with the fan-out's NO KEY UPDATE. */
const ACTIVITY: Vehicle = {
  table: "work_item_activity",
  insert: (tx, p) =>
    stamped(tx.$queryRaw<Row[]>`
      INSERT INTO work_item_activity (id, tenant_id, client_id, project_id, work_item_id, actor_member_id,
                                      field, new_value, visibility)
      VALUES (${randomUUID()}, ${T()}, ${p.clientId}, ${p.projectId}, ${p.anchorId}, ${f.seats.owner.memberId},
              'stateCategory', 'TODO', 'CLIENT_VISIBLE')
      RETURNING id, portal_enabled`),
};
/**
 * The product's own writer, `recomputeProjectMonth` — the one stamped
 * INSERT … ON CONFLICT, and lock-free — for a month with no row yet. Read
 * back in the same transaction: the value the stamp wrote, which is what
 * a RETURNING would have said.
 */
const SUMMARY: Vehicle = {
  table: "project_time_summary",
  insert: async (tx, p) => {
    const month = newMonth();
    await recomputeProjectMonth(tx, T(), p.projectId, month);
    return stamped(tx.$queryRaw<Row[]>`
      SELECT id, portal_enabled FROM project_time_summary
       WHERE tenant_id = ${T()} AND project_id = ${p.projectId} AND period_month = ${month}::date`);
  },
};
const REPORT: Vehicle = {
  table: "time_report",
  insert: (tx, p) =>
    stamped(tx.$queryRaw<Row[]>`
      INSERT INTO time_report (id, tenant_id, client_id, project_id, title, period_start, period_end, snapshot,
                               status, visibility, published_at, updated_at)
      VALUES (${randomUUID()}, ${T()}, ${p.clientId}, ${p.projectId}, ${`Report ${next()}`},
              DATE '2026-08-01', DATE '2026-08-31', '{"lines":[]}'::jsonb, 'PUBLISHED', 'CLIENT_VISIBLE', now(), now())
      RETURNING id, portal_enabled`),
};
const UPDATE: Vehicle = {
  table: "project_update",
  insert: (tx, p) =>
    stamped(tx.$queryRaw<Row[]>`
      INSERT INTO project_update (id, tenant_id, client_id, project_id, seq, health, body, portal_snapshot,
                                  status, visibility, author_member_id, published_at, published_by_member_id, updated_at)
      VALUES (${randomUUID()}, ${T()}, ${p.clientId}, ${p.projectId}, ${next()}, 'ON_TRACK', '{"sections":[]}'::jsonb,
              '{"version":1}'::jsonb, 'PUBLISHED', 'CLIENT_VISIBLE', ${f.seats.owner.memberId}, now(),
              ${f.seats.owner.memberId}, now())
      RETURNING id, portal_enabled`),
};

/** One per stamped table but `comment`, whose guard share-locks its subject. */
const VEHICLES: readonly Vehicle[] = [MILESTONE, VERSION, SERVICE, DOCUMENT, TASK, ACTIVITY, SUMMARY, REPORT, UPDATE];

// ── Holding a transaction open ────────────────────────────────────────

/** Thrown inside a held transaction to roll it back on purpose — recognised by class, or by its words if the client re-wraps it. */
const ROLLBACK = "rolled back on purpose (portal-switch-gate.dbtest)";
class Rollback extends Error {}

type Held<R> = {
  /** Resolves once `body` has run: its result, the backend's pid, and its 32-bit xid when one is assigned. */
  readonly ready: Promise<{ readonly result: R; readonly pid: number; readonly xid: string | null }>;
  readonly release: () => void;
  /** Settles when the transaction has ended — committed, or rolled back when asked. */
  readonly done: Promise<void>;
};

/**
 * A colleague's transaction: runs `body`, reports its backend (pg_locks
 * names a holder by pid) and its transaction id, stays open until
 * released, then runs `after` — still inside — and commits, or rolls
 * back. A body that throws never signals, so `ready` fails with its error
 * instead of hanging the case.
 */
function hold<R>(
  who: Principal,
  body: (tx: TenantDb) => Promise<R>,
  opts: { readonly after?: (tx: TenantDb) => Promise<unknown>; readonly rollback?: boolean } = {},
): Held<R> {
  let signal!: (held: { result: R; pid: number; xid: string | null }) => void;
  let release!: () => void;
  const signalled = new Promise<{ result: R; pid: number; xid: string | null }>((r) => (signal = r));
  const released = new Promise<void>((r) => (release = r));
  const done = withTenant(
    T(),
    who,
    async (tx) => {
      const result = await body(tx);
      // `_if_assigned`: reading the id must not assign one — the switch's
      // entry refuses a transaction that has one.
      const [me] = await tx.$queryRaw<{ pid: number; xid: string | null }[]>`
        SELECT pg_backend_pid() AS pid, (txid_current_if_assigned() % 4294967296)::text AS xid`;
      if (!me) throw new Error("the held transaction could not name its backend");
      signal({ result, pid: me.pid, xid: me.xid });
      await released;
      if (opts.after) await opts.after(tx);
      if (opts.rollback) throw new Rollback(ROLLBACK);
    },
    { timeoutMs: HOLD_MS },
  ).catch((e: unknown) => {
    if (!(e instanceof Rollback) && !describeError(e).includes(ROLLBACK)) throw e;
  });
  const ready = Promise.race([
    signalled,
    done.then((): never => {
      throw new Error("the held transaction ended without signalling");
    }),
  ]);
  return { ready, release, done };
}

/**
 * A raw flip of the switch, held: the fan-out's own try takes G exclusive
 * (the lock `portal_switch_begin` takes first in the product), then its
 * legs row-lock every child of the project.
 */
const flip = (projectId: string, enabled: boolean, opts: { readonly rollback?: boolean } = {}) =>
  hold(
    member(),
    async (tx) => {
      const n = await tx.$executeRaw`UPDATE project SET portal_enabled = ${enabled} WHERE tenant_id = ${T()} AND id = ${projectId}`;
      if (n !== 1) throw new Error(`the held switch updated ${n} projects`);
    },
    opts,
  );

/**
 * The switch's EXCLUSIVE hold on G with NO fan-out behind it — the window
 * between `portal_switch_begin` and the first leg. The same key, derived
 * inline exactly as `portal_gate_key_hi`/`_lo` derive it.
 */
const takeGate = (tx: TenantDb, projectId: string) =>
  tx.$executeRaw`
    SELECT pg_advisory_xact_lock((hashtextextended(${projectId}::text, ${G}::int8) >> 32)::int,
                                 ((hashtextextended(${projectId}::text, ${G}::int8) << 32) >> 32)::int)`;

/** A second switch, QUEUED on the gate: blocking, with a long bound of its own (setPortalEnabled's attempts leave gaps). */
const queueSwitch = (projectId: string): Promise<unknown> =>
  settle(
    withTenant(
      T(),
      member(),
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '20s'`;
        await tx.$executeRaw`SELECT portal_switch_begin(${projectId})`;
      },
      { timeoutMs: HOLD_MS },
    ),
  );

/** A plain row lock from the platform client — FOR NO KEY UPDATE fires no trigger: no stamp, no feed, no gate. */
function lockRow(table: "work_item" | "project_update" | "milestone" | "search_index", id: string) {
  let release!: () => void;
  let locked!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const isLocked = new Promise<void>((r) => (locked = r));
  const done = f.platform.$transaction(
    async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM ${table} WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE`,
        T(),
        id,
      );
      if (rows.length !== 1) throw new Error(`no ${table} row ${id} to hold`);
      locked();
      await released;
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  const ready = Promise.race([
    isLocked,
    done.then((): never => {
      throw new Error("the row lock ended before it was taken");
    }),
  ]);
  return { ready, release, done };
}

// ── Probes: pg_locks, scoped by database, key, mode and grant ─────────

/**
 * Locks on project P's advisory key for `seed` in THIS database — the
 * (int4, int4) form shows as objsubid 2, classid = the high half and
 * objid = the low half, both as unsigned oids — computed INLINE.
 */
async function gateLocks(
  projectId: string,
  seed: typeof G | typeof D,
  mode: "ShareLock" | "ExclusiveLock",
  granted: boolean,
  pid: number | null = null,
): Promise<number> {
  const rows = await f.platform.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks
     WHERE locktype = 'advisory' AND objsubid = 2
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid::bigint = ((hashtextextended(${projectId}::text, ${seed}::int8) >> 32) & 4294967295)
       AND objid::bigint = (hashtextextended(${projectId}::text, ${seed}::int8) & 4294967295)
       AND mode = ${mode} AND granted = ${granted}::boolean
       AND (${pid}::int IS NULL OR pid = ${pid}::int)`;
  return rows[0]?.n ?? 0;
}

/** A switch (or its entry) QUEUED for the gate exclusive. */
const switchQueued = async (projectId: string) => (await gateLocks(projectId, G, "ExclusiveLock", false)) > 0;
/** A reconcile (or the request broker) QUEUED for the gate shared. */
const sharedQueued = async (projectId: string) => (await gateLocks(projectId, G, "ShareLock", false)) > 0;

/** A switch HOLDING the gate while parked on a row: the same backend waits on a transaction id or a tuple. */
async function parkedOnRow(projectId: string): Promise<boolean> {
  const rows = await f.platform.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM pg_locks g JOIN pg_locks w ON w.pid = g.pid
     WHERE g.locktype = 'advisory' AND g.objsubid = 2 AND g.granted AND g.mode = 'ExclusiveLock'
       AND g.database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND g.classid::bigint = ((hashtextextended(${projectId}::text, ${G}::int8) >> 32) & 4294967295)
       AND g.objid::bigint = (hashtextextended(${projectId}::text, ${G}::int8) & 4294967295)
       AND NOT w.granted AND w.locktype IN ('transactionid', 'tuple')`;
  return (rows[0]?.n ?? 0) > 0;
}

/** Some transaction blocked on this one's id (work.dbtest.ts' xid-scoped probe). */
async function waitingOn(xid: string): Promise<boolean> {
  const rows = await f.platform.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks
     WHERE NOT granted AND locktype = 'transactionid' AND transactionid::text = ${xid}`;
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * THE RACE, once for every case: `call` must be SEEN waiting (`seen`)
 * before it settles. A call that settles first — because it never waited —
 * fails at once as "finished without waiting", with its own error if it
 * threw, never as a ten-second probe timeout that hides the cause.
 */
async function mustWait(
  call: Promise<unknown>,
  what: string,
  seen: () => Promise<boolean>,
): Promise<{ readonly lastMissAt: number | null }> {
  let over = false;
  // When the last probe that did NOT see it began: the state being waited
  // for cannot have begun before that probe's snapshot, so this is a LOWER
  // bound on when it began (null: the first probe already saw it).
  let lastMissAt: number | null = null;
  const watch = async (): Promise<void> => {
    const deadline = Date.now() + PROBE_MS;
    while (!over && Date.now() < deadline) {
      const at = Date.now();
      if (await seen()) return;
      lastMissAt = at;
      await pause(25);
    }
    if (!over) throw new Error(`${what} was never seen — the race was not exercised`);
  };
  try {
    await Promise.race([
      watch(),
      call.then(
        (): never => {
          throw new Error(`${what}: the call finished without waiting — the race was not exercised`);
        },
        (e: unknown): never => {
          throw e;
        },
      ),
    ]);
  } finally {
    over = true;
  }
  return { lastMissAt };
}

/** How many requests are QUEUED for the gate exclusive — a switch, and the holders a case lines up behind it. */
const exclusiveWaiters = (projectId: string) => gateLocks(projectId, G, "ExclusiveLock", false);

/**
 * Watch for `ms` for something that must NOT happen; true if it was seen.
 * The negative twin of `mustWait`, for a window the case has reasoned about.
 */
async function seenWithin(ms: number, seen: () => Promise<boolean>): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await seen()) return true;
    await pause(10);
  }
  return seen();
}

async function expectRefusal(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  const err = await settle(p);
  expect(err, `expected a refusal matching ${pattern}`).not.toBeNull();
  expect(describeError(err)).toMatch(pattern);
}

// ── Reads ─────────────────────────────────────────────────────────────

const PROJECT_TABLES = RLS_CLASSES.B_projectScoped.map(tableNameOf);
const NOTHING = Object.fromEntries(PROJECT_TABLES.map((t) => [t, 0]));
/** The ten stamped tables and the one unstamped copy. */
const STAMPED = [...PORTAL_ENABLED_FANOUT_TARGETS.map(tableNameOf), "search_index"];

/** What the contact reads of the project, raw, table by table (portal-gate.dbtest.ts' walk): `portal_gate` answers. */
async function contactCounts(projectId: string): Promise<Record<string, number>> {
  return withTenant(T(), contact(), async (tx) => {
    const out: Record<string, number> = {};
    for (const t of PROJECT_TABLES) {
      const col = t === "project" ? "id" : "project_id";
      const rows = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${t} WHERE ${col} = $1`, projectId);
      out[t] = rows[0]?.n ?? -1;
    }
    return out;
  });
}

/** Whether the contact reads one row, by id. */
async function contactSees(table: string, id: string): Promise<number> {
  return withTenant(T(), contact(), async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table} WHERE id = $1`, id);
    return rows[0]?.n ?? -1;
  });
}

/** search_index matches for a term, as a principal would see them (tree-guards.dbtest.ts). */
async function searchCount(principal: Principal, term: string): Promise<number> {
  return withTenant(T(), principal, async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM search_index
        WHERE search @@ websearch_to_tsquery('public.fortleva_sv', $1)`,
      term,
    );
    return rows[0]?.n ?? -1;
  });
}

/** A row's committed `portal_enabled`, read past RLS. */
async function stampOf(table: string, id: string): Promise<boolean | null> {
  const rows = await f.platform.$queryRawUnsafe<{ portal_enabled: boolean }[]>(
    `SELECT portal_enabled FROM ${table} WHERE tenant_id = $1 AND id = $2`,
    T(),
    id,
  );
  return rows[0]?.portal_enabled ?? null;
}

/** The committed `portal_enabled` of a row's search_index copy — the one leg no stamp re-derives. */
async function searchStamp(entityType: "WORK_ITEM" | "DOCUMENT", id: string): Promise<boolean | null> {
  const rows = await f.platform.$queryRaw<{ portal_enabled: boolean }[]>`
    SELECT portal_enabled FROM search_index
     WHERE tenant_id = ${T()} AND entity_type = ${entityType} AND entity_id = ${id}`;
  return rows[0]?.portal_enabled ?? null;
}

const switchOf = async (projectId: string): Promise<boolean> =>
  (await f.platform.project.findUniqueOrThrow({ where: { id: projectId }, select: { portalEnabled: true } })).portalEnabled;

/** Portal audit rows for ONE project — the tenant is shared by every case in the file. */
const auditCount = (projectId: string, action?: "project.portal_enabled" | "project.portal_disabled") =>
  f.platform.auditEvent.count({
    where: {
      tenantId: T(),
      targetId: projectId,
      action: action ?? { in: ["project.portal_enabled", "project.portal_disabled"] },
    },
  });

/** The reconcile's durable alarm for ONE project: who wrote it, and what it counted. */
const alarms = (projectId: string) =>
  f.platform.auditEvent.findMany({
    where: { tenantId: T(), action: "project.portal_stamp_alarm", targetId: projectId },
    orderBy: { createdAt: "asc" },
    select: { actorType: true, targetType: true, targetId: true, metadata: true },
  });

/**
 * THE ANOMALY THE GATE MAKES IMPOSSIBLE, manufactured where no stamp can
 * undo it: `search_index` has no trigger, so a platform-client UPDATE of
 * a search copy sticks — and a search copy is what a contact's search
 * reads. Returns the copy's own id.
 */
async function strayTrueSearchCopy(p: ProjectFx): Promise<string> {
  const rows = await f.platform.$queryRaw<{ id: string }[]>`
    UPDATE search_index SET portal_enabled = true
     WHERE tenant_id = ${T()} AND entity_type = 'WORK_ITEM' AND entity_id = ${p.anchorId}
    RETURNING id`;
  expect(rows, "the anchor's search copy").toHaveLength(1);
  return rows[0]!.id;
}

type Reconciled = { rows_fixed: number; rows_skipped: number; portal_on: boolean | null };

/**
 * ONE `portal_switch_reconcile` pass, called directly, in a transaction
 * of its own and as the SYSTEM — the principal `reconcilePortalStamps`
 * uses. UNLIKE the app's pass it is UNBOUNDED and NOT RETRIED: the app
 * sets a lock wait on each pass and retries a spent one; here a case that
 * wants a bound passes it in `first` (which runs before the call), and a
 * case that wants to watch the pass wait on the gate relies on there
 * being none.
 */
async function reconcile(projectId: string, first?: (tx: TenantDb) => Promise<unknown>): Promise<Reconciled | undefined> {
  const rows = await withTenant(
    T(),
    system(),
    async (tx) => {
      if (first) await first(tx);
      return tx.$queryRaw<Reconciled[]>`
        SELECT rows_fixed, rows_skipped, portal_on FROM portal_switch_reconcile(${T()}, ${projectId})`;
    },
    { timeoutMs: HOLD_MS },
  );
  return rows[0];
}

/**
 * ONE poll of the in-doubt key, in a transaction of its own and as the
 * SYSTEM, like one iteration of the app's drain — but only one: the app
 * polls in a loop until drained or its deadline, and counts a failed poll
 * as "not yet". (It takes no lock it could wait on, so it needs no bound.)
 */
async function drained(projectId: string): Promise<boolean | undefined> {
  const rows = await withTenant(T(), system(), (tx) =>
    tx.$queryRaw<{ drained: boolean }[]>`SELECT portal_doubt_drained(${projectId}) AS drained`,
  );
  return rows[0]?.drained;
}

/**
 * A row stranded FALSE in a project that is ON: written while a raw
 * DISABLE held the gate (its heal refused at its own commit), and the
 * DISABLE then rolled back — the one path, with a raw flip, that no
 * reconcile follows.
 */
async function stranded(insert: (tx: TenantDb) => Promise<Stamped>): Promise<Stamped> {
  const disable = flip(fx.projectId, false, { rollback: true });
  try {
    await disable.ready;
    return await withTenant(T(), member(), insert);
  } finally {
    disable.release();
    await disable.done;
  }
}

/**
 * The reconcile's own bounds (`src/projects/portal-gate.ts`, not exported):
 * the drain's deadline and a pass's wait on the gate, before the link
 * factor. The app-path cases below size their windows against them.
 */
const DRAIN_DEADLINE_MS = 1_000;
const RECONCILE_LOCK_WAIT_MS = 1_500;

/**
 * LINE A PRESS UP ON THE GATE so the moment its switch COMMITS is an event
 * a case can wait for, not a guess. A first holder takes the gate; the
 * press's switch queues behind it; a second holder queues behind the
 * switch; the first lets go. The second is then granted exactly when the
 * switch's transaction ends — which is when the press's reconcile begins —
 * and holds the gate exclusive until the case releases it. Returns the
 * press, still pending, and the second holder, already granted.
 */
async function pressBehindTheGate(
  projectId: string,
  enabled: boolean,
  cleanup: Held<unknown>[],
): Promise<{ press: Promise<{ changed: boolean }>; after: Held<number> }> {
  const before = hold(member(), (tx) => takeGate(tx, projectId));
  cleanup.push(before);
  await before.ready;
  const calledAt = Date.now();
  const press = setPortalEnabled(owner(), projectId, enabled);
  const { lastMissAt } = await mustWait(press, "the press queued on the gate", () => switchQueued(projectId));
  const after = hold(member(), (tx) => takeGate(tx, projectId));
  cleanup.push(after);
  await mustWait(press, "a holder queued behind the press", async () => (await exclusiveWaiters(projectId)) >= 2);
  before.release();
  await before.done;
  // Its first attempt must still have been queued when the gate was
  // freed, or a retry would have queued BEHIND the second holder and the
  // grant below would mean nothing.
  expect(
    Date.now() - (lastMissAt ?? calledAt),
    "the press's first attempt could have timed out in the queue",
  ).toBeLessThan(Number(lockTimeoutSetting(PORTAL_LOCK_WAIT_MS)));
  await after.ready;
  return { press, after };
}

/** Release every holder still open, in order, whatever the case did. */
async function releaseAll(held: Held<unknown>[]): Promise<void> {
  for (const h of held) {
    h.release();
    await settle(h.done);
  }
}

// ── A stamp never waits ───────────────────────────────────────────────

describe("a stamp never waits: it holds the gate shared, or fails closed at once", () => {
  it("insert first: the switch WAITS on the gate for the open write, then fans the straggler out — row and search copy", async () => {
    // The positive control: the anchor, the straggler's shape, is the contact's before the switch.
    expect((await contactCounts(fx.projectId)).work_item).toBe(1);
    expect(await searchCount(contact(), fx.anchorWord)).toBe(1);

    const probe = word("straggler");
    const writer = hold(member(), (tx) => insertTask(tx, fx, `Straggler ${probe}`));
    let switching: Promise<{ changed: boolean }> | null = null;
    let id = "";
    try {
      const { result } = await writer.ready;
      id = result.id;
      expect(result.portalEnabled).toBe(true); // ON, and no switch in flight
      switching = setPortalEnabled(owner(), fx.projectId, false);
      // HEAD: the switch never waits — the straggler is uncommitted, so no
      // leg can see it, and it then commits TRUE into a switched-off
      // project (C40 itself).
      await mustWait(switching, "the switch queued on the gate", () => switchQueued(fx.projectId));
    } finally {
      writer.release();
      await writer.done;
    }
    expect(await switching).toEqual({ changed: true });
    expect(await stampOf("work_item", id)).toBe(false);
    expect(await searchStamp("WORK_ITEM", id)).toBe(false);
    expect(await contactCounts(fx.projectId)).toEqual(NOTHING);
    expect(await searchCount(contact(), probe)).toBe(0);
    // Indexed all the same: the zero above is the gate, not a missing row.
    expect(await searchCount(member(), probe)).toBe(1);
    expect(await auditCount(fx.projectId, "project.portal_disabled")).toBe(1);
  });

  it("a switch in flight: every lock-free insert fails closed WITHOUT WAITING, and stays hidden once it commits", async () => {
    // The positive control: one committed row of every vehicle, the contact's.
    await withTenant(T(), member(), async (tx) => {
      for (const v of VEHICLES) await v.insert(tx, fx);
    });
    const before = await contactCounts(fx.projectId);
    for (const v of VEHICLES) expect(before[v.table], `${v.table}: the contact reads the control row`).toBeGreaterThan(0);

    const disable = flip(fx.projectId, false);
    const written: { v: Vehicle; row: Stamped }[] = [];
    try {
      await disable.ready;
      for (const v of VEHICLES) {
        // A wait would end as a 55P03 at three seconds, never as a RETURNING.
        const row = await withTenant(T(), member(), async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
          return v.insert(tx, fx);
        });
        written.push({ v, row });
        // HEAD: true — the old stamp read the committed switch, still ON.
        expect(row.portalEnabled, `${v.table}: stamped while the switch held the gate`).toBe(false);
      }
    } finally {
      disable.release();
      await disable.done;
    }
    for (const { v, row } of written) {
      expect(await stampOf(v.table, row.id), `${v.table}: still false after the DISABLE`).toBe(false);
      if (v.indexed) expect(await searchStamp(v.indexed, row.id), `${v.table}: its search copy`).toBe(false);
    }
    expect(await contactCounts(fx.projectId)).toEqual(NOTHING);
  });

  it("a switch QUEUED: a new writer fails closed without waiting and registers in doubt; the holder's own second write still reads", async () => {
    // The waitMask case: a try from a backend holding NOTHING on G is
    // refused by a queued exclusive request rather than queued behind it
    // — which is also why a stream of writers cannot starve the switch.
    const second: { row?: Stamped } = {};
    const w1 = hold(member(), (tx) => insertTask(tx, fx, `First ${word("wone")}`), {
      // After release and BEFORE W1 commits: the queuer is still queued.
      after: async (tx) => {
        second.row = await insertTask(tx, fx, `Second ${word("wone")}`);
      },
    });
    let queuer: Promise<unknown> = Promise.resolve(null);
    let w2: Held<Stamped> | null = null;
    let w2Row: Stamped | null = null;
    let w1Ended: unknown = null;
    try {
      const one = await w1.ready;
      expect(one.result.portalEnabled).toBe(true);
      // HEAD: 0 — the old stamp takes no gate at all.
      expect(await gateLocks(fx.projectId, G, "ShareLock", true, one.pid), "W1 holds the gate shared").toBe(1);
      queuer = queueSwitch(fx.projectId);
      await mustWait(queuer, "a switch queued on the gate", () => switchQueued(fx.projectId));
      w2 = hold(member(), async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        return insertTask(tx, fx, `Third ${word("wtwo")}`);
      });
      const two = await w2.ready;
      w2Row = two.result;
      expect(two.result.portalEnabled, "W2's try is refused by the queued exclusive request").toBe(false);
      expect(await gateLocks(fx.projectId, D, "ShareLock", true, two.pid), "W2 registered in doubt").toBe(1);
      expect(await switchQueued(fx.projectId), "W2 neither waited nor jumped the queue").toBe(true);
    } finally {
      w1.release();
      w1Ended = await settle(w1.done); // W1's second write runs here, the queuer still queued
      await queuer; // granted once W1 ends; it flips nothing and commits at once
      // W2 commits only AFTER the queued switch has ended, so its heal
      // finds the gate free.
      if (w2) {
        w2.release();
        await w2.done;
      }
    }
    expect(w1Ended, "W1 committed").toBeNull();
    expect(await queuer).toBeNull();
    expect(second.row?.portalEnabled, "W1's second write: the lock it already held, not a new request").toBe(true);
    expect(await stampOf("work_item", w2Row!.id), "W2 healed itself at its commit").toBe(true);
    expect(await searchStamp("WORK_ITEM", w2Row!.id)).toBe(true);
  });

  it("no cycle: a writer holding its task FOR SHARE, with a raw switch blocked on it, still writes — false — and both commit", async () => {
    // A BLOCKING stamp would close a wait-for cycle here: the writer holds
    // the task and waits on the switch; the switch's work_item leg waits
    // on the task. The switch is RAW so no retry can hide a 40P01; and this
    // is the one behavioural pin that the heal, too, never waits at COMMIT.
    const wrote: { comment?: Stamped; activity?: Stamped } = {};
    const writer = hold(
      member(),
      // NOTHING stamped first: a writer already holding G shared would make
      // the raw flip refuse ("raced a writer") instead of block.
      (tx) => tx.$queryRaw`SELECT id FROM work_item WHERE tenant_id = ${T()} AND id = ${fx.anchorId} FOR SHARE`,
      {
        after: async (tx) => {
          wrote.comment = await insertComment(tx, fx, { memberId: f.seats.owner.memberId });
          wrote.activity = await ACTIVITY.insert(tx, fx);
        },
      },
    );
    let flipping: Promise<unknown> = Promise.resolve(null);
    try {
      const { xid } = await writer.ready;
      if (!xid) throw new Error("the row lock assigned no transaction id");
      flipping = settle(
        withTenant(
          T(),
          member(),
          async (tx) => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '10s'`;
            await tx.$executeRaw`UPDATE project SET portal_enabled = false WHERE tenant_id = ${T()} AND id = ${fx.projectId}`;
          },
          { timeoutMs: HOLD_MS },
        ),
      );
      await mustWait(flipping, "the raw switch blocked on the writer's task", () => waitingOn(xid));
    } finally {
      writer.release();
      await writer.done; // commits — a deadlock would surface here, or in the switch, as a 40P01
    }
    expect(await flipping).toBeNull();
    // HEAD: true for both — the old stamp read the committed switch, still ON.
    expect(wrote.comment?.portalEnabled, "the comment, written under the switch's gate").toBe(false);
    expect(wrote.activity?.portalEnabled, "the history row, likewise").toBe(false);
    expect(await stampOf("comment", wrote.comment!.id)).toBe(false);
    expect(await stampOf("work_item_activity", wrote.activity!.id)).toBe(false);
  });
});

// ── The database enforces the gate ────────────────────────────────────

describe("the database enforces the gate, and checks its own premises", () => {
  it("the fan-out REFUSES a raw flip while a writer holds the gate — at once, and nothing changes", async () => {
    const writer = hold(member(), (tx) => insertTask(tx, fx, `Holder ${word("holder")}`));
    let held: Stamped | null = null;
    try {
      const w = await writer.ready;
      held = w.result;
      expect(w.result.portalEnabled).toBe(true);
      // HEAD: 0 — nothing holds any gate, and the flip below commits.
      expect(await gateLocks(fx.projectId, G, "ShareLock", true, w.pid), "the writer holds the gate shared").toBe(1);
      // A LONG bound on purpose: a fan-out that WAITED for G would sit out
      // ten seconds and then fail as a genuine lock timeout — the same
      // SQLSTATE — so the message and the clock are what tell a try from a
      // wait (never `expectLockTimeout`).
      const started = Date.now();
      await expectRefusal(
        f.platform.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '10s'`;
            await tx.$executeRaw`UPDATE project SET portal_enabled = false WHERE tenant_id = ${T()} AND id = ${fx.projectId}`;
          },
          { timeout: 30_000, maxWait: 10_000 },
        ),
        /raced a writer/,
      );
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      writer.release();
      await writer.done;
    }
    expect(await switchOf(fx.projectId)).toBe(true);
    expect(await stampOf("work_item", fx.anchorId)).toBe(true);
    expect(await stampOf("work_item", held!.id)).toBe(true);
  });

  it("under REPEATABLE READ a stamp fails closed and arms nothing; a flip, the switch's entry and the reconcile refuse", async () => {
    // The proof needs a fresh snapshot per statement. Nothing in the
    // product runs another level; these pin what happens if something does.
    const rr = { isolationLevel: "RepeatableRead" as const, timeout: 30_000, maxWait: 10_000 };
    const { row, inDoubt, doubtLocks } = await f.platform.$transaction(async (tx) => {
      const written = await insertTask(tx, fx, `Snapshot ${word("rr")}`);
      // Read INSIDE the transaction, while anything it armed is still
      // held: the committed row alone cannot tell "armed nothing" from
      // "armed a heal that then did nothing under RR".
      const [me] = await tx.$queryRaw<{ in_doubt: boolean; pid: number }[]>`
        SELECT current_setting('app.portal_in_doubt', true) IS NOT DISTINCT FROM 'on' AS in_doubt,
               pg_backend_pid() AS pid`;
      const doubtLocks = me ? await gateLocks(fx.projectId, D, "ShareLock", true, me.pid) : -1;
      return { row: written, inDoubt: me?.in_doubt, doubtLocks };
    }, rr);
    // HEAD: true — the old stamp read the switch at any level.
    expect(row.portalEnabled).toBe(false);
    // …and it ARMED NOTHING: no heal (a heal would read the same stale
    // snapshot) and no registration in doubt.
    expect(inDoubt, "the in-doubt flag was not set").toBe(false);
    expect(doubtLocks, "no registration on D").toBe(0);
    expect(await stampOf("work_item", row.id)).toBe(false);
    // HEAD: the flip commits.
    await expectRefusal(
      f.platform.$transaction(
        (tx) => tx.$executeRaw`UPDATE project SET portal_enabled = false WHERE tenant_id = ${T()} AND id = ${fx.projectId}`,
        rr,
      ),
      /must run under READ COMMITTED/,
    );
    expect(await switchOf(fx.projectId)).toBe(true);
    await expectRefusal(
      f.platform.$transaction((tx) => tx.$executeRaw`SELECT portal_switch_begin(${fx.projectId})`, rr),
      /portal_switch_begin: the portal switch must run under READ COMMITTED/,
    );
    await expectRefusal(
      f.platform.$transaction(
        (tx) => tx.$queryRaw`SELECT rows_fixed FROM portal_switch_reconcile(${T()}, ${fx.projectId})`,
        rr,
      ),
      /portal_switch_reconcile: must run under READ COMMITTED/,
    );
  });

  it("the gate's blocking entries and the reconcile refuse a transaction that already has an id; the drain likewise", async () => {
    // Waiting on the gate while holding anything could close the very
    // cycle the migration exists to avoid, so each asserts it holds
    // nothing yet. HEAD: each fails as a missing function, not with these words.
    const entries: [RegExp, (tx: TenantDb) => Promise<unknown>][] = [
      [/portal_switch_begin: the gate must be taken before the transaction writes or row-locks anything/, (tx) => tx.$executeRaw`SELECT portal_switch_begin(${fx.projectId})`],
      [/portal_gate_enter_shared: the gate must be taken before the transaction writes or row-locks anything/, (tx) => tx.$executeRaw`SELECT portal_gate_enter_shared(${fx.projectId})`],
      [/portal_switch_reconcile: the gate must be taken before the transaction writes or row-locks anything/, (tx) => tx.$queryRaw`SELECT rows_fixed FROM portal_switch_reconcile(${T()}, ${fx.projectId})`],
      [/portal_doubt_drained: must run in a transaction of its own/, (tx) => tx.$queryRaw`SELECT portal_doubt_drained(${fx.projectId}) AS drained`],
    ];
    for (const [refusal, call] of entries) {
      await expectRefusal(
        withTenant(T(), member(), async (tx) => {
          await tx.$queryRaw`SELECT txid_current()::text AS xid`;
          await call(tx);
        }),
        refusal,
      );
    }
  });
});

// ── setPortalEnabled decides under the gate ───────────────────────────

describe("setPortalEnabled decides under the gate", () => {
  it("a writer that outlasts every attempt: PORTAL_SWITCH_BUSY after the gate's lock waits, and nothing is written", async () => {
    const writer = hold(member(), (tx) => insertTask(tx, fx, `Long ${word("long")}`));
    let refusal: unknown = null;
    let elapsed = 0;
    let row: Stamped | null = null;
    try {
      row = (await writer.ready).result;
      expect(row.portalEnabled).toBe(true);
      const started = Date.now();
      refusal = await settle(setPortalEnabled(owner(), fx.projectId, false));
      elapsed = Date.now() - started;
    } finally {
      writer.release();
      await writer.done;
    }
    // HEAD: null — the switch sails through ({changed: true}), and the
    // writer then commits TRUE into a switched-off project.
    expect(refusal).toMatchObject({ name: "DomainError", code: "PORTAL_SWITCH_BUSY" });
    // At least one whole lock wait: the bound fired, nothing else threw.
    expect(elapsed).toBeGreaterThanOrEqual(PORTAL_LOCK_WAIT_MS);
    expect(await switchOf(fx.projectId)).toBe(true);
    expect(await auditCount(fx.projectId)).toBe(0);
    expect(await stampOf("work_item", row!.id)).toBe(true);
    expect(await contactSees("work_item", row!.id)).toBe(1);
  }, LONG);

  it("two presses in the SAME direction are one transition: the second waits on the gate, re-reads, and changes nothing", async () => {
    const first = flip(fx.projectId, false);
    let second: Promise<{ changed: boolean }> | null = null;
    try {
      await first.ready;
      second = setPortalEnabled(owner(), fx.projectId, false);
      // HEAD: never seen — the old switch read ON unlocked and parked on
      // the project ROW instead; released, it re-applied OFF and audited a
      // transition that did not happen.
      await mustWait(second, "the second press queued on the gate", () => switchQueued(fx.projectId));
    } finally {
      first.release();
      await first.done;
    }
    expect(await second).toEqual({ changed: false });
    expect(await switchOf(fx.projectId)).toBe(false);
    expect(await auditCount(fx.projectId, "project.portal_disabled")).toBe(0);
  });

  it("an OFF pressed while an ON is in flight is ordered AFTER it — and switches the portal off", async () => {
    const p = await addProject(fx.clientId, false);
    const on = flip(p.projectId, true);
    let off: Promise<{ changed: boolean }> | null = null;
    try {
      await on.ready;
      off = setPortalEnabled(owner(), p.projectId, false);
      // HEAD: {changed: false} at once — the unlocked read saw OFF, and the
      // ON then landed: the portal ends ON after the member pressed OFF.
      await mustWait(off, "the OFF queued behind the ON", () => switchQueued(p.projectId));
    } finally {
      on.release();
      await on.done;
    }
    expect(await off).toEqual({ changed: true });
    expect(await switchOf(p.projectId)).toBe(false);
    expect(await auditCount(p.projectId, "project.portal_disabled")).toBe(1);
    expect(await stampOf("work_item", p.anchorId)).toBe(false);
  });

  it("a no-op press waits for an open stamped writer (bounded), then answers {changed: false}", async () => {
    const writer = hold(member(), (tx) => insertTask(tx, fx, `Open ${word("open")}`));
    let press: Promise<{ changed: boolean }> | null = null;
    try {
      expect((await writer.ready).result.portalEnabled).toBe(true);
      press = setPortalEnabled(owner(), fx.projectId, true);
      // HEAD: answers at once, from an unlocked read.
      await mustWait(press, "the no-op press queued on the gate", () => switchQueued(fx.projectId));
    } finally {
      writer.release();
      await writer.done;
    }
    expect(await press).toEqual({ changed: false });
    expect(await auditCount(fx.projectId)).toBe(0);
  });

  it("REGRESSION PIN — green before this slice by design: a held title edit (no stamp, no gate) still serialises with the DISABLE by its row lock, and its search copy ends false", async () => {
    // The migration header's claim for NON-stamping search copies: they
    // take no gate, and the fan-out's work_item leg — which waits on the
    // edited row and re-fires the feed — is what keeps them honest.
    expect(await searchCount(contact(), fx.anchorWord)).toBe(1);
    const edit = hold(
      member(),
      (tx) => tx.$executeRaw`UPDATE work_item SET title = ${`Anchor ${fx.anchorWord} edited`} WHERE tenant_id = ${T()} AND id = ${fx.anchorId}`,
    );
    let switching: Promise<{ changed: boolean }> | null = null;
    try {
      const { xid } = await edit.ready;
      if (!xid) throw new Error("the edit assigned no transaction id");
      switching = setPortalEnabled(owner(), fx.projectId, false);
      await mustWait(switching, "the switch blocked on the held edit", () => waitingOn(xid));
    } finally {
      edit.release();
      await edit.done;
    }
    expect(await switching).toEqual({ changed: true });
    expect(await searchStamp("WORK_ITEM", fx.anchorId)).toBe(false);
    expect(await searchCount(contact(), fx.anchorWord)).toBe(0);
    expect(await searchCount(member(), fx.anchorWord)).toBe(1);
  });
});

// ── Liveness: what failed closed comes back ───────────────────────────

describe("liveness: a row that failed closed comes back", () => {
  it("THE HEAL: a write that failed closed during an ENABLE re-derives itself at its own commit — every vehicle, member and system", async () => {
    for (const who of [member(), system()]) {
      const p = await addProject(fx.clientId, false);
      const enable = flip(p.projectId, true);
      const written: { v: Vehicle; row: Stamped }[] = [];
      let writer: Held<void> | null = null;
      try {
        await enable.ready;
        writer = hold(who, async (tx) => {
          // A stamp that WAITED on the gate would fail here in three
          // seconds, not hang the case to its timeout.
          await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
          for (const v of VEHICLES) written.push({ v, row: await v.insert(tx, p) });
        });
        await writer.ready;
        for (const { v, row } of written) {
          expect(row.portalEnabled, `${who.type} ${v.table}: in doubt while the ENABLE holds the gate`).toBe(false);
        }
      } finally {
        enable.release();
        await enable.done; // the ENABLE commits first…
        if (writer) {
          writer.release();
          await writer.done; // …then the writer, whose COMMIT runs every heal — and must succeed
        }
      }
      for (const { v, row } of written) {
        // HEAD: false — nothing ever revisits a row stamped while an ENABLE was in flight.
        expect(await stampOf(v.table, row.id), `${who.type} ${v.table}: healed at its commit`).toBe(true);
        if (v.indexed) expect(await searchStamp(v.indexed, row.id), `${who.type} ${v.table}: its search copy`).toBe(true);
        expect(await contactSees(v.table, row.id), `${who.type} ${v.table}: the contact reads it`).toBe(1);
      }
    }
  }, LONG);

  it("after a DISABLE that rolled back, the reconcile repairs the row it made fail closed — exactly (1, 0, true)", async () => {
    const probe = word("stranded");
    const row = await stranded((tx) => insertTask(tx, fx, `Stranded ${probe}`));
    // HEAD: true — the old stamp read the committed switch.
    expect(row.portalEnabled).toBe(false);
    // Its heal ran while the DISABLE held the gate and was refused; the
    // rollback repaired nothing. Hidden, in a project that is ON.
    expect(await stampOf("work_item", row.id)).toBe(false);
    expect(await searchStamp("WORK_ITEM", row.id)).toBe(false);
    expect(await contactSees("work_item", row.id)).toBe(0);
    // ONE row, not two: the work_item leg re-fires the item's search feed,
    // which re-copies the flag before the search leg looks.
    expect(await reconcile(fx.projectId)).toEqual({ rows_fixed: 1, rows_skipped: 0, portal_on: true });
    expect(await stampOf("work_item", row.id)).toBe(true);
    expect(await searchStamp("WORK_ITEM", row.id)).toBe(true);
    expect(await searchCount(contact(), probe)).toBe(1);
  });

  it("the drain: an in-doubt writer registers on D, a poll sees it until it ends, and its own heal makes it TRUE", async () => {
    const p = await addProject(fx.clientId, false);
    const enable = flip(p.projectId, true);
    let writer: Held<Stamped> | null = null;
    let id = "";
    let whileOpen: boolean | undefined;
    try {
      await enable.ready;
      writer = hold(member(), async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`; // a stamp that waited fails fast
        return insertTask(tx, p, `Doubt ${word("doubt")}`);
      });
      const w = await writer.ready;
      id = w.result.id;
      expect(w.result.portalEnabled).toBe(false);
      // HEAD: 0 — nothing registers doubt.
      expect(await gateLocks(p.projectId, D, "ShareLock", true, w.pid), "registered in doubt").toBe(1);
      enable.release();
      await enable.done;
      whileOpen = await drained(p.projectId);
    } finally {
      enable.release();
      await enable.done;
      if (writer) {
        writer.release();
        await writer.done;
      }
    }
    expect(whileOpen, "not drained while the in-doubt writer is open").toBe(false);
    expect(await drained(p.projectId)).toBe(true);
    expect(await stampOf("work_item", id)).toBe(true);
  });

  it("a DISABLE that ends PORTAL_SWITCH_BUSY leaves nothing hidden: a row that failed closed during it is TRUE when the call returns", async () => {
    // A plain row lock on the anchor parks every attempt at the work_item
    // leg, holding the gate, until the attempts are spent.
    const held = lockRow("work_item", fx.anchorId);
    const probe = word("busy");
    let inserted: Stamped | null = null;
    try {
      await held.ready;
      const started = Date.now();
      const switching = setPortalEnabled(owner(), fx.projectId, false);
      // HEAD: never seen — the old switch parks on the row holding no gate.
      await mustWait(switching, "the switch holding the gate while parked on a row", () => parkedOnRow(fx.projectId));
      // ONE autocommit statement: its stamp and its deferred heal run in
      // the same round trip, both while this attempt holds the gate — so
      // the row commits false, not healed.
      inserted = await insertTask(f.platform, fx, `Busy ${probe}`);
      expect(inserted.portalEnabled).toBe(false);
      expect(await stampOf("work_item", inserted.id), "committed false: its heal was refused too").toBe(false);
      await expect(switching).rejects.toMatchObject({ name: "DomainError", code: "PORTAL_SWITCH_BUSY" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(PORTAL_LOCK_WAIT_MS);
      // WHEN THE CALL RETURNS — the anchor still held — the reconcile it
      // ran on the failure path has re-derived the row.
      expect(await stampOf("work_item", inserted.id)).toBe(true);
      expect(await searchStamp("WORK_ITEM", inserted.id)).toBe(true);
    } finally {
      held.release();
      await held.done;
    }
    expect(await switchOf(fx.projectId)).toBe(true);
    expect(await auditCount(fx.projectId)).toBe(0);
    expect(await contactSees("work_item", inserted!.id)).toBe(1);
  }, LONG);

  it("an ENABLE parked on its last leg: a row committed during it, false, is TRUE when the call returns", async () => {
    // Parked at the project_update leg — PAST the work_item leg, whose
    // snapshot never held the row — so only the reconcile can make it TRUE.
    const p = await addProject(fx.clientId, false);
    const draft = await f.platform.projectUpdate.create({
      data: {
        tenantId: T(),
        clientId: p.clientId,
        projectId: p.projectId,
        health: "ON_TRACK",
        body: { sections: [] },
        authorMemberId: f.seats.owner.memberId,
      },
      select: { id: true },
    });
    const held = lockRow("project_update", draft.id);
    let switching: Promise<{ changed: boolean }> | null = null;
    let inserted: Stamped | null = null;
    try {
      await held.ready;
      const calledAt = Date.now();
      switching = setPortalEnabled(owner(), p.projectId, true);
      // HEAD: never seen — no gate; and the row below would stay false forever.
      const { lastMissAt } = await mustWait(switching, "the ENABLE holding the gate while parked on a row", () =>
        parkedOnRow(p.projectId),
      );
      // A LOWER bound on when the row wait began — the start of the last
      // probe that did not see it, or the call itself — so the check below
      // over-counts the wait rather than under-counting it.
      const parkedNoEarlierThan = lastMissAt ?? calledAt;
      // Nothing but the insert between the park and the release: every
      // round trip here is one the first attempt's lock wait must outlive.
      inserted = await insertTask(f.platform, p, `Late ${word("late")}`);
      expect(inserted.portalEnabled).toBe(false);
      held.release();
      await held.done; // the row is free once this COMMIT is acknowledged
      // THE FIRST ATTEMPT MUST STILL HAVE BEEN ALIVE WHEN THE ROW WAS FREED.
      // Had its lock wait expired, the second attempt's fan-out would see
      // the committed row and make it TRUE itself — and this case would
      // pass without the reconcile (on a slow link, silently). Failing
      // loudly instead. The bound is the one the switch itself runs under,
      // link factor included.
      expect(
        Date.now() - parkedNoEarlierThan,
        "the first attempt's lock wait could have expired before the row was freed — the reconcile is what this case proves",
      ).toBeLessThan(Number(lockTimeoutSetting(PORTAL_LOCK_WAIT_MS)));
    } finally {
      held.release(); // promptly, so the first attempt goes through
      await held.done;
    }
    expect(await switching).toEqual({ changed: true });
    expect(await stampOf("work_item", inserted!.id)).toBe(true);
    expect(await searchStamp("WORK_ITEM", inserted!.id)).toBe(true);
    expect(await contactSees("work_item", inserted!.id)).toBe(1);
  }, LONG);

  it("THE APP'S DRAIN: while the in-doubt writer is open, no pass asks for the gate within one drain poll's window; the pass after the drain repairs what the writer's own heal could not", async () => {
    // What the drain is FOR: a writer in doubt whose own heal runs while a
    // switch still holds the gate commits FALSE, and only a pass run AFTER
    // that commit can repair it. So this case makes the heal fail — the
    // second holder of `pressBehindTheGate` holds the gate from the
    // instant the press's switch commits, across the writer's commit — and
    // asks two things: that no pass so much as ASKED for the gate while the
    // writer was open (a pass run before the drain, or with no drain at
    // all, would, and would queue behind the holder where the probe sees
    // it); and that the row is TRUE when the call returns.
    //
    // EVENT-ORDERED, not timed, with one exception: the window the absence
    // is watched for. It must be long enough for a pass issued as the drain
    // begins to reach the gate — one drain poll's round trips, measured
    // here — and must end before the drain's EARLIEST give-up (a poll
    // returns false once now + its next pause, at most 250 ms, passes the
    // deadline), when the correct code's own pass would ask. A link too
    // slow for both fails loudly below rather than proving less. Past the
    // window nothing is timed: a pass that asks later waits for the holder,
    // which is released only after the writer's commit, so it repairs the
    // row either way.
    const p = await addProject(fx.clientId, false);
    const enable = flip(p.projectId, true);
    const cleanup: Held<unknown>[] = [enable];
    let press: Promise<{ changed: boolean }> | null = null;
    let id = "";
    let passWhileOpen: boolean | null = null;
    let committed: boolean | null = null;
    try {
      await enable.ready;
      const writer = hold(member(), async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`; // a stamp that waited fails fast
        return insertTask(tx, p, `Drained ${word("drained")}`);
      });
      cleanup.unshift(writer);
      const w = await writer.ready;
      id = w.result.id;
      expect(w.result.portalEnabled).toBe(false);
      // HEAD: 0 — nothing registers doubt.
      expect(await gateLocks(p.projectId, D, "ShareLock", true, w.pid), "registered in doubt").toBe(1);
      enable.release();
      await enable.done; // ON now; the writer holds D and NOT the gate
      // The window, measured on a project with nothing in doubt.
      const pollStarted = Date.now();
      expect(await drained(fx.projectId)).toBe(true);
      const window = Date.now() - pollStarted + 50;
      expect(window, "this link is too slow for the drain case's window — set DB_TX_TIMEOUT_MS").toBeLessThan(
        Number(lockTimeoutSetting(DRAIN_DEADLINE_MS)) - 300,
      );
      const lined = await pressBehindTheGate(p.projectId, true, cleanup);
      press = lined.press;
      // The switch has committed and the drain has begun: the writer is
      // still open, so the correct code only polls D.
      passWhileOpen = await seenWithin(window, () => sharedQueued(p.projectId));
      writer.release();
      await writer.done; // its heal is REFUSED: the second holder has the gate
      committed = await stampOf("work_item", id);
      lined.after.release();
      await lined.after.done;
    } finally {
      await releaseAll(cleanup);
    }
    const answer = await press;
    const atReturn = await stampOf("work_item", id);
    expect(passWhileOpen, "a reconcile pass asked for the gate while the in-doubt writer was still open").toBe(false);
    expect(committed, "the writer's own heal was refused: it committed false").toBe(false);
    expect(answer).toEqual({ changed: false });
    expect(atReturn, "only a pass run after the drain can have made it TRUE").toBe(true);
  }, LONG);

  it("THE APP'S PASSES: a stranded row another transaction holds is skipped by the first pass and taken by a later one before the call returns", async () => {
    // EVENT-ORDERED: the first pass is made VISIBLE — the second holder of
    // `pressBehindTheGate`, granted as the switch commits, makes it queue
    // for the gate where the probe sees it. Released, that pass runs with
    // the row still held, skips it, and commits; only once it is gone is
    // the row freed, a whole inter-pass pause before the next pass looks.
    // With a single pass the call would return with the row still false.
    const row = await stranded((tx) => MILESTONE.insert(tx, fx));
    // HEAD: true.
    expect(row.portalEnabled).toBe(false);
    const held = lockRow("milestone", row.id);
    const cleanup: Held<unknown>[] = [];
    let press: Promise<{ changed: boolean }> | null = null;
    try {
      await held.ready;
      const lined = await pressBehindTheGate(fx.projectId, true, cleanup);
      press = lined.press;
      const grantedAt = Date.now();
      const { lastMissAt } = await mustWait(press, "the first pass queued for the gate", () => sharedQueued(fx.projectId));
      lined.after.release();
      await lined.after.done;
      // It was still queued when the gate was freed — not timed out and
      // retried, which would put a gap where the probe below could land.
      expect(
        Date.now() - (lastMissAt ?? grantedAt),
        "the first pass could have timed out on the gate",
      ).toBeLessThan(Number(lockTimeoutSetting(RECONCILE_LOCK_WAIT_MS)));
      await mustWait(press, "the first pass ended, the row still held", async () => {
        const [queued, granted] = [
          await gateLocks(fx.projectId, G, "ShareLock", false),
          await gateLocks(fx.projectId, G, "ShareLock", true),
        ];
        return queued + granted === 0;
      });
      held.release();
      await held.done;
    } finally {
      held.release();
      await settle(held.done);
      await releaseAll(cleanup);
    }
    expect(await press).toEqual({ changed: false });
    expect(await stampOf("milestone", row.id), "a later pass took the row once it was free").toBe(true);
  }, LONG);

  it("the reconcile never waits on a row: a stranded row another transaction holds is reported, not waited for", async () => {
    // A MILESTONE, not a task: a task's search copy is a second row the
    // holder does not lock, which the reconcile would rightly fix — (1, 1).
    const row = await stranded((tx) => MILESTONE.insert(tx, fx));
    // HEAD: true.
    expect(row.portalEnabled).toBe(false);
    const held = lockRow("milestone", row.id);
    let first: Reconciled | undefined;
    let elapsed = 0;
    try {
      await held.ready;
      const started = Date.now();
      first = await reconcile(fx.projectId, (tx) => tx.$executeRaw`SET LOCAL lock_timeout = '10s'`);
      elapsed = Date.now() - started;
    } finally {
      held.release();
      await held.done;
    }
    // Well inside the bound: a wait would have ended as a lock timeout, not a result.
    expect(first).toEqual({ rows_fixed: 0, rows_skipped: 1, portal_on: true });
    expect(elapsed).toBeLessThan(10_000);
    expect(await stampOf("milestone", row.id)).toBe(false);
    // Released, the next pass takes it.
    expect(await reconcile(fx.projectId)).toEqual({ rows_fixed: 1, rows_skipped: 0, portal_on: true });
    expect(await stampOf("milestone", row.id)).toBe(true);
  });
});

// ── Safety at the edges ───────────────────────────────────────────────

describe("safety at the edges", () => {
  it("the reconcile cannot write a stale TRUE across a DISABLE: it waits for the gate BEFORE it reads the switch", async () => {
    // search_index is the one leg no stamp re-derives, so it is the only
    // place a reconcile that read the switch first — or took no gate —
    // could write TRUE over a just-disabled project. That mutant leaks
    // here; one that takes no gate skips the locked rows and never waits,
    // and the probe fails first.
    //
    // HEAD: fails as a missing function (`portal_switch_reconcile` is this
    // slice's) — after the positive control below has passed.
    expect(await searchCount(contact(), fx.anchorWord)).toBe(1); // the positive control
    const disable = flip(fx.projectId, false);
    let reconciling: Promise<Reconciled | undefined> | null = null;
    try {
      await disable.ready;
      reconciling = reconcile(fx.projectId); // no bound of its own
      await mustWait(reconciling, "the reconcile queued on the gate, shared", () => sharedQueued(fx.projectId));
    } finally {
      disable.release();
      await disable.done;
    }
    expect(await reconciling).toEqual({ rows_fixed: 0, rows_skipped: 0, portal_on: false });
    const [live] = await f.platform.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM search_index
       WHERE tenant_id = ${T()} AND project_id = ${fx.projectId} AND portal_enabled`;
    expect(live?.n).toBe(0);
    expect(await searchCount(contact(), fx.anchorWord)).toBe(0);
  });

  it("an ENABLE with a second switch QUEUED: the fan-out's own stamps are granted the gate (PG 18's early grant) — every child TRUE inside the switch", async () => {
    // A Postgres that refused them would leave those rows false for the
    // reconcile — and a raw flip, which runs none, would leave them.
    //
    // HEAD: fails as a missing function (`portal_switch_begin` is this
    // slice's) — after the not-vacuous checks below have passed.
    const p = await addProject(fx.clientId, false);
    await withTenant(T(), member(), async (tx) => {
      for (const v of VEHICLES) await v.insert(tx, p);
      await insertComment(tx, p, { memberId: f.seats.owner.memberId });
    });
    // Not vacuous: every table has rows to fan out, all false while the portal is off.
    for (const t of STAMPED) {
      const [c] = await f.platform.$queryRawUnsafe<{ n: number; off: number }[]>(
        `SELECT count(*)::int AS n, (count(*) FILTER (WHERE NOT portal_enabled))::int AS off
           FROM ${t} WHERE tenant_id = $1 AND project_id = $2`,
        T(),
        p.projectId,
      );
      expect(c?.n, `${t}: rows to fan out`).toBeGreaterThan(0);
      expect(c?.off, `${t}: all off before the ENABLE`).toBe(c?.n);
    }
    const inside: { off?: Record<string, number>; inDoubt?: boolean; shared?: number } = {};
    let pid = 0;
    const switching = hold(member(), (tx) => tx.$executeRaw`SELECT portal_switch_begin(${p.projectId})`, {
      after: async (tx) => {
        await tx.$executeRaw`UPDATE project SET portal_enabled = true WHERE tenant_id = ${T()} AND id = ${p.projectId}`;
        const off: Record<string, number> = {};
        for (const t of STAMPED) {
          const [c] = await tx.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1 AND project_id = $2 AND NOT portal_enabled`,
            T(),
            p.projectId,
          );
          off[t] = c?.n ?? -1;
        }
        inside.off = off;
        const [guc] = await tx.$queryRaw<{ in_doubt: boolean }[]>`
          SELECT current_setting('app.portal_in_doubt', true) IS NOT DISTINCT FROM 'on' AS in_doubt`;
        inside.inDoubt = guc?.in_doubt;
        inside.shared = await gateLocks(p.projectId, G, "ShareLock", true, pid);
      },
    });
    let queued: Promise<unknown> = Promise.resolve(null);
    try {
      pid = (await switching.ready).pid;
      queued = queueSwitch(p.projectId);
      // Queued BEFORE the switch's UPDATE runs (in `after`).
      await mustWait(queued, "a second switch queued on the gate", () => switchQueued(p.projectId));
    } finally {
      switching.release();
      await switching.done; // the ENABLE commits…
      await queued; // …then the queued switch is granted, and commits
    }
    expect(await queued).toBeNull();
    expect(inside.off).toEqual(Object.fromEntries(STAMPED.map((t) => [t, 0])));
    expect(inside.inDoubt, "no stamp of the switch's own failed closed").toBe(false);
    expect(inside.shared, "the switch's stamps hold the gate shared beside its exclusive hold").toBe(1);
  }, LONG);

  it("a contact's comment during a switch is refused: the stamp fails closed and the policy's WITH CHECK does the rest", async () => {
    // The GATE alone, with no fan-out behind it — so no row is locked and
    // the comment guard's FOR SHARE on the task is free; under a fanned-out
    // DISABLE the guard would wait instead, identically before and after
    // this slice, and prove nothing.
    const gate = hold(member(), (tx) => takeGate(tx, fx.projectId));
    const comment = () =>
      withTenant(T(), contact(), async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`; // a stamp that WAITED would fail on this, not on the policy
        return insertComment(tx, fx, { contactId: fx.contactId });
      });
    try {
      await gate.ready;
      // HEAD: accepted, portal_enabled true — the old stamp never looked at a gate.
      await expectRefusal(comment(), /row-level security/i);
    } finally {
      gate.release();
      await gate.done;
    }
    // The positive control: the same insert, the gate free.
    expect((await comment()).portalEnabled).toBe(true);
  });

  it("THE ALARM: a press on a switched-OFF project that finds a row the client could read corrects it, and records project.portal_stamp_alarm in the same transaction", async () => {
    const p = await addProject(fx.clientId, false);
    // The positive control first: a no-op press on a CLEAN switched-off
    // project runs its passes and records nothing.
    expect(await setPortalEnabled(owner(), p.projectId, false)).toEqual({ changed: false });
    expect(await alarms(p.projectId)).toEqual([]);

    await strayTrueSearchCopy(p);
    // The anomaly is real: the contact can find a task of a switched-off project.
    expect(await searchCount(contact(), p.anchorWord)).toBe(1);

    expect(await setPortalEnabled(owner(), p.projectId, false)).toEqual({ changed: false });
    // HEAD: true — a no-op press ran nothing after it, and the copy stayed readable.
    expect(await searchStamp("WORK_ITEM", p.anchorId)).toBe(false);
    expect(await searchCount(contact(), p.anchorWord)).toBe(0);
    expect(await alarms(p.projectId)).toEqual([
      {
        actorType: "SYSTEM",
        targetType: "Project",
        targetId: p.projectId,
        metadata: { corrected: 1, stillDisagreeing: 0 },
      },
    ]);
    // THE SAME TRANSACTION, measured rather than claimed: the corrected
    // copy and the alarm row carry one transaction id. The correction
    // destroys the evidence (a TRUE turned false), so the two must commit
    // together or not at all; `portal_switch_reconcile` has no EXCEPTION
    // block, so no subtransaction can give the copy an xmin of its own.
    const [copy] = await f.platform.$queryRaw<{ xmin: string }[]>`
      SELECT xmin::text AS xmin FROM search_index
       WHERE tenant_id = ${T()} AND entity_type = 'WORK_ITEM' AND entity_id = ${p.anchorId}`;
    const [alarm] = await f.platform.$queryRaw<{ xmin: string }[]>`
      SELECT xmin::text AS xmin FROM audit_event
       WHERE tenant_id = ${T()} AND action = 'project.portal_stamp_alarm' AND target_id = ${p.projectId}`;
    expect(copy?.xmin, "the corrected copy").toBeDefined();
    expect(alarm?.xmin, "the alarm was written by the transaction that corrected the copy").toBe(copy?.xmin);
  });

  it("THE ALARM, still held: a readable row of an OFF project that every pass finds held is reported once, after the passes — and corrected by the next press", async () => {
    const p = await addProject(fx.clientId, false);
    const copy = await strayTrueSearchCopy(p);
    // Held across the WHOLE call: every pass skips it (SKIP LOCKED) and
    // counts it, and the alarm after the last pass reports it uncorrected.
    const held = lockRow("search_index", copy);
    let answer: { changed: boolean } | null = null;
    let whileHeld: boolean | null = null;
    try {
      await held.ready;
      answer = await setPortalEnabled(owner(), p.projectId, false);
      whileHeld = await searchStamp("WORK_ITEM", p.anchorId);
    } finally {
      held.release();
      await held.done;
    }
    expect(answer).toEqual({ changed: false });
    expect(whileHeld, "never waited for, never corrected while held").toBe(true);
    // HEAD: [] — nothing ran after the press.
    expect(await alarms(p.projectId)).toEqual([
      {
        actorType: "SYSTEM",
        targetType: "Project",
        targetId: p.projectId,
        metadata: { corrected: 0, stillDisagreeing: 1 },
      },
    ]);
    // Freed, the next press corrects it — and records THAT, in the pass
    // that did it.
    expect(await setPortalEnabled(owner(), p.projectId, false)).toEqual({ changed: false });
    expect(await searchStamp("WORK_ITEM", p.anchorId)).toBe(false);
    expect((await alarms(p.projectId)).map((a) => a.metadata)).toEqual([
      { corrected: 0, stillDisagreeing: 1 },
      { corrected: 1, stillDisagreeing: 0 },
    ]);
  }, LONG);
});
