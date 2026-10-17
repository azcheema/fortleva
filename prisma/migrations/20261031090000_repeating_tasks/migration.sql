-- ═══════════════════════════════════════════════════════════════════
-- Slice 127 — REPEATING TASKS (founder decision C103 (a)–(f);
-- docs/research/2026-10-17-slice-127-repeating-tasks-design.md §3.1, §4).
--
-- A task can be set to repeat — every week, every 2 weeks, every month,
-- every 3 months or every year. On each repeat day the jobs route makes a
-- fresh copy of it (INTERNAL, in the stage where new tasks start, due the
-- day before the next copy) and the setting MOVES to the copy, so the
-- newest task is always the one the next copy is made from. Two tables,
-- both class A (tenant_isolation + portal_deny); `work_item` itself is not
-- altered.
--
--   `work_item_repeat` — one row per repeating series: the task the NEXT
--   copy is made from (`work_item_id`, the newest — UNIQUE), the rhythm,
--   the anchor day of the month for the month rhythms (NULL for the week
--   ones), and the next repeat day as a workspace-local DATE. Stopping a
--   repeat DELETES the row.
--
--   `work_item_repeat_item` — one row per task of a series: the task the
--   repeat was set on (`made_for` NULL) and every copy, with the repeat
--   day it was made for. A task is in at most one series (the primary
--   key); a series has at most one task per day (`(repeat_id, made_for)`
--   UNIQUE) — the database's belt against two copies for one day, whoever
--   writes — and at most one task it was set on (the partial UNIQUE).
--   Goes with its series.
--
-- Both cascade from `work_item` (a task is soft-deleted by the product and
-- hard-deleted only with its project or by the harness), so neither the
-- harness's `removeTenant` nor the dbtest teardown needs a line; both
-- RESTRICT the tenant, as every table does.
--
-- CONTACT WRITES AND READS: none. `portal_deny` closes both tables to a
-- contact principal outright; `work_item`'s policies are unchanged.
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. Left out of
-- Prisma's generated diff, as every migration's hand-written objects are:
-- this one adds CHECKs and a partial UNIQUE (Prisma models neither).
-- ═══════════════════════════════════════════════════════════════════

-- ── The table lock, FIRST ───────────────────────────────────────────
-- The foreign keys below take `work_item` in SHARE ROW EXCLUSIVE. Taken
-- here, before anything else, with a BOUNDED wait: behind a dev server or a
-- test run writing tasks the migration either gets the table within ten
-- seconds and holds it for its few milliseconds, or fails clean. (`tenant`
-- is taken in the same mode by its two foreign keys, under the same bound.)
SET LOCAL lock_timeout = '10s';
LOCK TABLE work_item IN SHARE ROW EXCLUSIVE MODE;

-- CreateTable
CREATE TABLE "work_item_repeat" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "rhythm" TEXT NOT NULL,
    "anchor_day" SMALLINT,
    "next_on" DATE NOT NULL,
    "created_by_member_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "work_item_repeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_item_repeat_item" (
    "tenant_id" TEXT NOT NULL,
    "repeat_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "made_for" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_repeat_item_pkey" PRIMARY KEY ("tenant_id", "work_item_id")
);

-- CreateIndex: the composite-FK target.
CREATE UNIQUE INDEX "work_item_repeat_tenant_id_id_key" ON "work_item_repeat"("tenant_id", "id");

-- CreateIndex: ONE series per task the next copy is made from.
CREATE UNIQUE INDEX "work_item_repeat_tenant_id_work_item_id_key" ON "work_item_repeat"("tenant_id", "work_item_id");

-- CreateIndex: the job's read — the series due in a workspace.
CREATE INDEX "work_item_repeat_tenant_id_next_on_idx" ON "work_item_repeat"("tenant_id", "next_on");

-- CreateIndex: ONE task per series and repeat day — two kicks, a retry or a
-- careless writer can never make a second copy for the same day. NULLs are
-- distinct here, so the task the repeat was set on (`made_for` NULL) is
-- held by the partial index below instead.
CREATE UNIQUE INDEX "work_item_repeat_item_tenant_id_repeat_id_made_for_key" ON "work_item_repeat_item"("tenant_id", "repeat_id", "made_for");

-- ONE task a series was set on.
CREATE UNIQUE INDEX work_item_repeat_item_one_origin
  ON work_item_repeat_item (tenant_id, repeat_id)
  WHERE made_for IS NULL;

-- AddForeignKey
ALTER TABLE "work_item_repeat" ADD CONSTRAINT "work_item_repeat_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: with the task the next copy is made from. The product only
-- soft-deletes tasks (a series whose task is in the bin waits, design §3.5);
-- a hard delete comes with the project, or from the harness.
ALTER TABLE "work_item_repeat" ADD CONSTRAINT "work_item_repeat_tenant_id_work_item_id_fkey" FOREIGN KEY ("tenant_id", "work_item_id") REFERENCES "work_item"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_repeat_item" ADD CONSTRAINT "work_item_repeat_item_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: with its series — Stop repeating deletes the series, and
-- the older copies become plain tasks.
ALTER TABLE "work_item_repeat_item" ADD CONSTRAINT "work_item_repeat_item_tenant_id_repeat_id_fkey" FOREIGN KEY ("tenant_id", "repeat_id") REFERENCES "work_item_repeat"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: with the task.
ALTER TABLE "work_item_repeat_item" ADD CONSTRAINT "work_item_repeat_item_tenant_id_work_item_id_fkey" FOREIGN KEY ("tenant_id", "work_item_id") REFERENCES "work_item"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── CHECKs — the series' own shape ──────────────────────────────────
-- The five rhythms of C103 (e). The month ones carry the day of the month
-- they repeat on (1–31); the week ones carry none — their weekday is the
-- next day's own, and a step of 7 or 14 days never changes it.
--
-- A MONTH RHYTHM'S NEXT DAY LANDS ON ITS ANCHOR, or on its month's last day
-- when the month is shorter (`src/lib/repeat-rules.ts`, the agreements'
-- `addIntervals` rule): a series on the 31st is next on 28 February and on
-- 31 March again, never drifting to the 28th for good. The cast to
-- `timestamp` (without time zone) keeps the expression immutable.
ALTER TABLE work_item_repeat
  ADD CONSTRAINT work_item_repeat_rhythm_known
    CHECK (rhythm IN ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY')),
  ADD CONSTRAINT work_item_repeat_anchor_shape
    CHECK ((rhythm IN ('WEEKLY', 'BIWEEKLY')) = (anchor_day IS NULL)
           AND (anchor_day IS NULL OR anchor_day BETWEEN 1 AND 31)),
  ADD CONSTRAINT work_item_repeat_anchor_lands
    CHECK (anchor_day IS NULL
           OR EXTRACT(DAY FROM next_on) = LEAST(
                anchor_day,
                EXTRACT(DAY FROM (date_trunc('month', next_on::timestamp) + INTERVAL '1 month' - INTERVAL '1 day'))
              ));

-- ── Grants ──────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON work_item_repeat TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON work_item_repeat_item TO app_runtime;

-- ── RLS — class A (portal_deny; no visibility) ──────────────────────
ALTER TABLE work_item_repeat ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_repeat FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON work_item_repeat
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON work_item_repeat
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

ALTER TABLE work_item_repeat_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_repeat_item FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON work_item_repeat_item
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON work_item_repeat_item
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
