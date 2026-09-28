-- ── The portal switch GATE: a child row can no longer keep a switched-off
--    project's `portal_enabled = true` (Phase 3 slice 74, OPEN_QUESTIONS C40)
--
-- THE RACE THIS CLOSES. `stamp_portal_enabled()` (20260816180000) derives
-- a child row's `portal_enabled` from its project with a PLAIN, lock-free
-- SELECT, on ten tables (milestone, project_version, service, document,
-- work_item, work_item_activity, comment, project_time_summary,
-- time_report, project_update). The switch UPDATEs `project.portal_enabled`
-- — FOR NO KEY UPDATE on the project row — and `project_portal_enabled_
-- fanout()` (latest 20260925200000) re-sets the ten tables and
-- `search_index`. A child INSERT's foreign-key check takes FOR KEY SHARE
-- on the project, which does NOT conflict with FOR NO KEY UPDATE, and the
-- stamp took nothing. So a row written by a transaction still open when a
-- DISABLE's fan-out took its snapshot kept `true` — and its search_index
-- copy with it — after the portal was off, until the next DISABLE. A row
-- inserted INTERNAL in that instant and shared later was exposed too:
-- visibility changes do not re-stamp.
--
-- WHY NOT A BLOCKING LOCK IN THE STAMP (the 2026-09-11 candidates). Any
-- lock the stamp WAITS on — FOR SHARE on the project, or a blocking shared
-- advisory lock — closes a new wait-for cycle with the switch for every
-- writer that locks a row of the project BEFORE its first stamped insert:
-- the writer holds row W and waits on the switch; the switch's fan-out
-- waits on W. The design review counted ~25 such paths (createItem's
-- bottom-rank FOR UPDATE, every comment writer through
-- comment_denorm_guard's FOR SHARE, transitionState, the bulk verbs, the
-- cascade…), most with no retry. Today they can only BLOCK the switch,
-- which is bounded and retried; a blocking stamp would turn a manager's
-- toggle into a failed comment. A deferred re-check at commit that WAITS
-- has the same cycle. Rejected, both.
--
-- THE GATE (G). One transaction-scoped advisory key per project, in the
-- (int4, int4) space — the product's other advisory keys are all the
-- one-bigint form, a separate space (objsubid 1 vs 2) — made from the
-- 64-bit `hashtextextended` of the project id, so two projects share a
-- key with probability ~2^-64 (a 32-bit hash made a collision real at
-- scale, and a colliding project's rows were never repaired). The switch
-- holds G EXCLUSIVE; every stamp TRIES it SHARED and never waits:
--
--   * try succeeds → the stamp reads the switch as before and holds G
--     shared to commit: "I read the switch; wait for me before you move
--     it". A switch that wants G waits for this write, then fans out over
--     a snapshot that contains it.
--   * try fails → a switch holds G or is queued for it, and its outcome
--     cannot be known from here. The row is written FALSE (fail closed),
--     the write registers as IN DOUBT on a second key (D, try-only), and
--     a commit-time heal is armed.
--
-- A stamp never waits on G, so G adds no wait and no deadlock to any
-- write except the one that asks to wait on it (the client's request
-- broker, below). The fan-out's row locks block and can deadlock with
-- writers exactly as before (src/modules/work/rank-lock.ts keeps that
-- ledger). The switch (`setPortalEnabled`) takes G with
-- `portal_switch_begin` before it writes or row-locks anything — the
-- function refuses a transaction that already has a transaction id,
-- which a write or a row lock assigns; it cannot see an advisory lock
-- taken earlier, so "G before any other advisory key" is kept by the
-- calling code — and so the writers it waits for can never be waiting on
-- a row it holds. While it is queued, new stamps fail their try (the
-- queued exclusive request is in the lock's wait mask) instead of
-- queueing behind it, so a stream of writers cannot starve it within an
-- attempt.
--
-- THE DATABASE ENFORCES G FOR EVERY PATH: the fan-out TRIES G exclusive
-- before its legs and refuses the flip (55P03, retryable) when a writer
-- holds it — for `setPortalEnabled`, which already holds it, that is a
-- re-acquire. Between a raw flip's UPDATE and that try a stamp may take G
-- and read the committed old value; the try then fails and the flip rolls
-- back, so that order cannot leak.
--
-- LIVENESS — ROWS THAT FAILED CLOSED. Two repairs, and between them every
-- in-doubt write is covered however long it runs, except the residuals
-- listed below:
--   * THE HEAL (`<t>_portal_heal`, a deferred constraint trigger) runs at
--     the writer's own commit, before the commit is visible. It TRIES G
--     shared; if the switch is done it re-derives the row itself. So a
--     long writer (a 60 s bulk verb, the cascade) that outlives the switch
--     heals itself.
--   * THE RECONCILE, which `setPortalEnabled` runs ONCE PER CALL, in its
--     `finally`, after the last attempt, whenever any attempt asked for
--     G, first waits — by POLLING D with a try in short
--     transactions of its own, never by queueing — until every in-doubt
--     writer registered on D has ended and is visible (a transaction's
--     locks are released only after its commit is visible), then takes G
--     shared and re-derives every row of the project that disagrees with
--     the switch. That covers a writer whose heal ran while the switch
--     still held G, including one whose commit became visible only after
--     the switch let go. When the switch ended OFF the polling is skipped
--     (every row in doubt is already false) and the passes run as an
--     ALARM: a pass that reads the switch OFF and finds rows disagreeing
--     records `project.portal_stamp_alarm`. The passes run as the system,
--     each in its own transaction, retried on a lock timeout or deadlock.
-- What is left, fail-closed only — each leaves rows false, hidden from the
-- client, until the project is next switched:
--   (a) an in-doubt writer still running when the reconcile's polling
--       deadline passes AND whose heal also ran while a switch held G;
--   (b) a registration on D that coincided with the instant a drain
--       poll's own short transaction held D (NOT logged);
--   (c) rows still disagreeing after the reconcile's passes because
--       other writers held them (logged as a give-up);
--   (d) a reconcile that errored (logged);
--   (e) the process dying after the switch committed (NOT logged).
-- A raw flip (dbtests) runs no reconcile.
--
-- ROWS THE OLD RACE MAY ALREADY HAVE LEFT TRUE are not repaired here
-- (DDL only). A read-only count on 2026-09-28, over all eleven tables in
-- the dev database — the only database holding the naxdor tenant's data
-- — found 0 rows disagreeing with their project in either direction.
--
-- SAFETY — WHY A DISABLE NEVER LEAKS. For a row of P written while a
-- DISABLE S runs: its stamp took G before S asked for it (S waits for it,
-- then its legs — fresh READ COMMITTED snapshots taken after S holds G —
-- see it and set it false); or it failed its try (false); or it ran after
-- S committed (its SELECT, a fresh snapshot taken after the try, reads
-- false; a commit is visible before its locks are released). The heal
-- writes TRUE only while holding G shared, after reading the switch — no
-- switch can commit in between. The reconcile likewise reads the switch
-- only after taking G shared; that order is what keeps its search_index
-- leg (which no stamp re-derives) from writing a stale TRUE after a
-- DISABLE, and isolation.dbtest.ts pins it. A search_index copy made by a
-- NON-stamping source UPDATE (a title edit, a comment edit, a document's
-- updated_at bump) takes no gate: it is serialised with S by the source
-- row's own lock instead — the fan-out's document, work_item and comment
-- legs lock every source row of P and re-fire the feeds (each covers
-- `portal_enabled`), and the search_index leg runs after them on a fresh
-- snapshot.
--
-- THE PREMISES THE PROOF RESTS ON, each pinned: READ COMMITTED (fresh
-- snapshots per statement — the stamp fails closed, the heal does
-- nothing, and the fan-out, the switch's entry and the reconcile refuse,
-- under any other level); VOLATILE plpgsql (a STABLE stamp would reuse the
-- outer statement's snapshot — isolation.dbtest.ts checks provolatile);
-- the fan-out as the only way a committed switch changes (no BEFORE
-- UPDATE trigger on project writes portal_enabled: `AFTER UPDATE OF
-- portal_enabled` matches only the statement's SET list, so such a
-- trigger would change the switch without the fan-out or its gate —
-- isolation.dbtest.ts pins project's exact trigger set). On PG 18 (the schema
-- needs it: uuidv7) the fan-out's own stamps are granted G shared while
-- the switch holds it exclusive even with another switch queued (the
-- dontWait early grant, PG 17+); a Postgres that refused them would leave
-- those rows false for the reconcile, and a raw flip would leave them.
--
-- WHAT IT COSTS. Each FIRST stamp of a project in a transaction takes one
-- shared lock-table entry (advisory locks never use the fast path), held
-- to commit; a writer touching many projects in one transaction
-- (repriceRateCard, releaseContactAssignments) takes one per project. A
-- write that stamped a project now delays that project's switch until it
-- commits — the switch's lock wait bounds that, as it bounds every other,
-- and a writer that outlasts every attempt makes the switch
-- PORTAL_SWITCH_BUSY. The request broker's gate wait is its third bounded
-- wait (REQUEST_BUSY when spent). An in-doubt writer pays, at its commit,
-- one heal per row written false after its first fail-closed stamp (a
-- try, a read of the project, a dynamic UPDATE, the stamp and a search
-- feed) while holding G shared — only in a transaction a switch put in
-- doubt. Every switch press now also runs, after its transaction, a
-- drain poll (skipped when it ended OFF) and a reconcile pass: normally
-- two short transactions, and two indexed scans of the project's rows in
-- each of eleven tables.
--
-- A CORRECTION to 20260816180000:479-481, which says "a contact never
-- inserts these rows": a contact's own comment is a direct INSERT under
-- the contact principal (the census's one permitted INSERT), and it fires
-- `comment_stamp_portal_enabled`. With a switch in flight it now fails
-- closed — and the comment policy's WITH CHECK then refuses it. The slice
-- that ships contact comments must enter G shared first, as the request
-- broker does (`portal_gate_enter_shared`). The heal does nothing under a
-- contact principal, and that return is load-bearing: a contact may not
-- write portal_enabled or project_id on any of these tables
-- (portal_no_update; on project_version and document,
-- portal_contact_columns_only admits only the approval columns), so the
-- heal's UPDATE would be REFUSED at commit and fail the contact's write.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch is owed.

-- ── 1. The keys: two halves of one 64-bit hash, seeded per key ─────────
--    G is seed 7401, D is seed 7402.
CREATE FUNCTION portal_gate_key_hi(p_project text, p_seed integer) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT (hashtextextended(p_project, p_seed) >> 32)::integer $$;

-- The low 32 bits, sign-extended into int4's range.
CREATE FUNCTION portal_gate_key_lo(p_project text, p_seed integer) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT ((hashtextextended(p_project, p_seed) << 32) >> 32)::integer $$;

-- ── 2. The entries ──────────────────────────────────────────────────────
-- G, try-only, for the stamp and the heal: never waits.
CREATE FUNCTION portal_gate_try_shared(p_project text) RETURNS boolean
LANGUAGE sql VOLATILE
AS $$ SELECT pg_try_advisory_xact_lock_shared(portal_gate_key_hi(p_project, 7401),
                                              portal_gate_key_lo(p_project, 7401)) $$;

-- G, try-only, for the fan-out's enforcement: never waits.
CREATE FUNCTION portal_gate_try_exclusive(p_project text) RETURNS boolean
LANGUAGE sql VOLATILE
AS $$ SELECT pg_try_advisory_xact_lock(portal_gate_key_hi(p_project, 7401),
                                       portal_gate_key_lo(p_project, 7401)) $$;

-- D, try-only, for a stamp that failed closed: "I am in doubt about P
-- until I end". Never waits; held to the writer's end.
CREATE FUNCTION portal_doubt_register(p_project text) RETURNS boolean
LANGUAGE sql VOLATILE
AS $$ SELECT pg_try_advisory_xact_lock_shared(portal_gate_key_hi(p_project, 7402),
                                              portal_gate_key_lo(p_project, 7402)) $$;

-- D, try-only, EXCLUSIVE: true when no in-doubt writer of P is still
-- running. The reconcile polls it in short transactions of its own, so D
-- is held exclusive only for the instant between a successful try and
-- that transaction's commit — and never queued for, so a registration is
-- refused only in that instant.
CREATE FUNCTION portal_doubt_drained(p_project text) RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
  IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
    RAISE EXCEPTION 'portal_doubt_drained: must run in a transaction of its own';
  END IF;
  RETURN pg_try_advisory_xact_lock(portal_gate_key_hi(p_project, 7402),
                                   portal_gate_key_lo(p_project, 7402));
END
$fn$;

-- The switch's entry to G. BLOCKING, bounded by the caller's
-- lock_timeout, and only before the transaction writes or row-locks
-- anything: waiting here while holding a row could close exactly the
-- cycle this migration exists to avoid. The check is "no transaction id
-- yet" — a write or a row lock assigns one; an advisory lock taken
-- earlier does not, and is invisible to it, so ordering G before other
-- advisory keys is the calling code's job.
CREATE FUNCTION portal_switch_begin(p_project text) RETURNS void
LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
  IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
    RAISE EXCEPTION 'portal_switch_begin: the gate must be taken before the transaction writes or row-locks anything';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'portal_switch_begin: the portal switch must run under READ COMMITTED';
  END IF;
  PERFORM pg_advisory_xact_lock(portal_gate_key_hi(p_project, 7401),
                                portal_gate_key_lo(p_project, 7401));
END
$fn$;

-- A writer's entry to G that WAITS a switch out instead of failing
-- closed — for the one write that must not be born invisible: a client's
-- request. Same precondition, same bound.
CREATE FUNCTION portal_gate_enter_shared(p_project text) RETURNS void
LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
  IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
    RAISE EXCEPTION 'portal_gate_enter_shared: the gate must be taken before the transaction writes or row-locks anything';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(portal_gate_key_hi(p_project, 7401),
                                       portal_gate_key_lo(p_project, 7401));
END
$fn$;

-- ── 3. The stamp: try G, fail closed when a switch is in flight ────────
CREATE OR REPLACE FUNCTION stamp_portal_enabled() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  enabled boolean;
BEGIN
  IF NEW.project_id IS NULL THEN
    NEW.portal_enabled := true;
    RETURN NEW;
  END IF;
  -- The proof needs a fresh snapshot per statement. Nothing in the
  -- product runs another level; if something ever does, fail closed and
  -- arm nothing (a heal would read the same stale snapshot).
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    NEW.portal_enabled := false;
    RETURN NEW;
  END IF;
  IF NOT portal_gate_try_shared(NEW.project_id) THEN
    NEW.portal_enabled := false;
    PERFORM portal_doubt_register(NEW.project_id);
    PERFORM set_config('app.portal_in_doubt', 'on', true);
    RETURN NEW;
  END IF;
  SELECT p.portal_enabled INTO enabled
    FROM project p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id;
  NEW.portal_enabled := COALESCE(enabled, false);
  RETURN NEW;
END
$fn$;

-- ── 4. The heal: at the writer's own commit, if the switch is done ─────
-- Fires only for rows written false by a top-level statement after this
-- transaction's first fail-closed stamp (a constraint trigger's WHEN is
-- evaluated when the row is written, not at commit, and the heal's own
-- UPDATE runs at trigger depth 1, so it can never queue another heal).
-- Try-only, so it never waits; it does nothing outside READ COMMITTED
-- and nothing under a contact principal (whose UPDATE of these columns the
-- census refuses — the header), so it never raises. The row is
-- this transaction's own, so its UPDATE waits on no one. It writes only
-- toward TRUE, only while holding G shared, and only after reading the
-- switch.
CREATE FUNCTION portal_heal_in_doubt() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  enabled boolean;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RETURN NULL;
  END IF;
  IF (SELECT current_setting('app.principal', true)) = 'contact' THEN
    RETURN NULL;
  END IF;
  IF NOT portal_gate_try_shared(NEW.project_id) THEN
    RETURN NULL;
  END IF;
  SELECT p.portal_enabled INTO enabled
    FROM project p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id;
  IF enabled IS TRUE THEN
    EXECUTE format(
      'UPDATE %I.%I SET portal_enabled = true WHERE tenant_id = $1 AND id = $2 AND NOT portal_enabled',
      TG_TABLE_SCHEMA, TG_TABLE_NAME)
    USING NEW.tenant_id, NEW.id;
  END IF;
  RETURN NULL;
END
$fn$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['milestone', 'project_version', 'service', 'document',
                           'work_item', 'work_item_activity', 'comment',
                           'project_time_summary', 'time_report', 'project_update'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_portal_heal', t);
    EXECUTE format($t$
      CREATE CONSTRAINT TRIGGER %I
        AFTER INSERT OR UPDATE OF project_id, portal_enabled ON %I
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        WHEN (NEW.project_id IS NOT NULL AND NOT NEW.portal_enabled
              AND current_setting('app.portal_in_doubt', true) = 'on'
              AND pg_trigger_depth() = 0)
        EXECUTE FUNCTION portal_heal_in_doubt()
    $t$, t || '_portal_heal', t);
  END LOOP;
END
$$;

-- ── 5. The fan-out: the same eleven legs, behind G ─────────────────────
CREATE OR REPLACE FUNCTION project_portal_enabled_fanout() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
  IF NEW.portal_enabled IS DISTINCT FROM OLD.portal_enabled THEN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'project_portal_enabled_fanout: the portal switch must run under READ COMMITTED';
    END IF;
    IF NOT portal_gate_try_exclusive(NEW.id) THEN
      RAISE EXCEPTION 'portal switch of project % raced a writer; retry', NEW.id
        USING ERRCODE = '55P03';
    END IF;
    UPDATE milestone            SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE project_version      SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE service              SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE document             SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE work_item            SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE work_item_activity   SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE comment              SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE search_index         SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE project_time_summary SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE time_report          SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE project_update       SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
  END IF;
  RETURN NULL;
END
$fn$;

-- ── 6. The reconcile: re-derive what failed closed and is still false ──
-- Its own transaction, after the switch's and after the D polling, which
-- the app skips when the switch ended OFF (`src/projects/portal-gate.ts`). Takes G SHARED (so no switch commits between its read of
-- the switch and its writes) BEFORE it reads the switch; never waits on a
-- row a writer holds (SKIP LOCKED — such a row is reported, not waited
-- for). A source leg's search feed upserts search_index without SKIP
-- LOCKED, so it can wait on a concurrent reconcile's search leg or on the
-- locale restamp (restampSearchLang, which locks search rows without their
-- sources — with two or more stale rows that is a possible 40P01, retried
-- on this side, not on the restamp's; rank-lock.ts records it); corrects in both directions and
-- reports it, so a row turned FALSE after a committed DISABLE reaches the
-- caller as the alarm it would be. Legs written out table by table, in the
-- fan-out's order, so isolation.dbtest.ts can pin each one the way it pins
-- the fan-out's.
CREATE FUNCTION portal_switch_reconcile(p_tenant text, p_project text)
RETURNS TABLE (rows_fixed integer, rows_skipped integer, portal_on boolean)
LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  v boolean;
  n integer;
BEGIN
  rows_fixed := 0;
  rows_skipped := 0;
  portal_on := NULL;
  IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
    RAISE EXCEPTION 'portal_switch_reconcile: the gate must be taken before the transaction writes or row-locks anything';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'portal_switch_reconcile: must run under READ COMMITTED';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(portal_gate_key_hi(p_project, 7401),
                                       portal_gate_key_lo(p_project, 7401));
  SELECT p.portal_enabled INTO v FROM project p WHERE p.tenant_id = p_tenant AND p.id = p_project;
  IF NOT FOUND THEN
    RETURN NEXT;
    RETURN;
  END IF;
  portal_on := v;

  UPDATE milestone SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM milestone WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE project_version SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM project_version WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE service SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM service WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE document SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM document WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE work_item SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM work_item WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE work_item_activity SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM work_item_activity WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE comment SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM comment WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE search_index SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM search_index WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE project_time_summary SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM project_time_summary WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE time_report SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM time_report WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE project_update SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM project_update WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;

  -- Rows still disagreeing at this later snapshot: the ones SKIP LOCKED
  -- passed over, plus any written since (e.g. a writer failed closed by a
  -- NEW switch queued behind this pass's shared hold). The caller retries
  -- a few passes, then logs.
  SELECT
      (SELECT count(*) FROM milestone            WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM project_version      WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM service              WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM document             WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM work_item            WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM work_item_activity   WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM comment              WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM search_index         WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM project_time_summary WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM time_report          WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM project_update       WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    INTO rows_skipped;
  RETURN NEXT;
END
$fn$;
