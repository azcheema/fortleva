-- ── When the agency took a request on ───────────────────────────────
--
-- Founder decision C31 (2026-09-25): a request the agency ACCEPTED and
-- later stopped reads "Cancelled" on the client's portal; one turned
-- down in triage still reads "Declined". Slice 6b (20260922120000) made
-- the two look the same in the database: ACCEPT clears every triage
-- column, so an accepted request is indistinguishable from work that
-- was always ordinary, and once it is cancelled — with the reply the
-- state machine insists on — it is indistinguishable from a request
-- declined at the door. The portal announced "Declined" for both, in
-- the agency's name, to a client who had watched the task sit in
-- Planned for a fortnight. The one fact it lacked is this column.
--
-- WHY A TIMESTAMP AND NOT A BOOLEAN — the argument `contact_completed_at`
-- made one slice earlier: "when did we take this on" is the question a
-- member surface asks the moment the flag exists, and a boolean cannot
-- answer it later. Nullable, so absence is "never accepted" rather than
-- a `false` somebody has to maintain. THE PORTAL READS ONLY WHETHER IT
-- IS SET, never the value: `listPortalTasks` selects it to choose the
-- category and does not return it — UI.md §11's "shown to a contact"
-- side names no such date, and a projection that published one would
-- be widening the contract to save itself a comparison.
--
-- WRITTEN BY `transitionState` (src/modules/work/states.ts), the one
-- seam every state change passes through, on a `kind = REQUEST` row's
-- FIRST arrival in a live category (BACKLOG, TODO, IN_PROGRESS, DONE)
-- from TRIAGE or CANCELLED. The lane's Accept, a board drag out of the
-- lane and a reopen of a declined request are all the agency agreeing
-- to the work, and only the first of them is recorded, like
-- `started_at`. NEVER CLEARED: cancelling agreed work and reopening it
-- again does not un-agree what was agreed, and a request cannot
-- re-enter TRIAGE at all (`transitionState` refuses the move), so
-- there is no path on which "accepted" stops being true.
ALTER TABLE "work_item" ADD COLUMN "accepted_at" TIMESTAMPTZ(6);

-- ── No CHECK, and that is a decision rather than an omission ────────
--
-- The two columns before this one each shipped with a constraint
-- because each guarded an invariant whose breach is paid for by the
-- client: a decline with no reason, a claim with no claimant. This one
-- guards a WORD. The candidate — "a live REQUEST has been accepted"
-- (`kind <> 'REQUEST' OR state_category IN ('TRIAGE','CANCELLED') OR
-- accepted_at IS NOT NULL`) — would refuse every hand-planted live
-- request in the fixture suites and every row the backfill below could
-- not date, and the failure it prevents is the portal saying "Declined"
-- where "Cancelled" is truer: imprecise, and nothing hidden. A
-- constraint that fails loudly to prevent a quiet imprecision is the
-- wrong trade; the projection's fail-safe is the reason term it already
-- has, which this column does not touch.
--
-- NO INDEX. The column is read as a field of rows the portal already
-- fetches by (tenant, client, visibility) and the member surfaces by
-- id; nothing filters on it.

-- ── DML: the requests accepted before the column existed ────────────
--
-- Without this, every request already taken on reads "Declined" when
-- it is later stopped — safe, and exactly the imprecision the decision
-- ends. The audit trail can date them exactly: `transitionState` has
-- written `work_item.state_changed` with `{from, to}` CATEGORIES since
-- 2W, and an acceptance is precisely a REQUEST leaving TRIAGE (the
-- lane's Accept writes this event too, beside its own
-- `work_item.triaged`) or leaving CANCELLED (a reopen) for a live
-- category. MIN(created_at) is the first such moment, which is the
-- value the service would have stamped. A request that was accepted by
-- some path this trail does not record cannot exist: every state
-- change in the product goes through that one function.
--
-- WHAT IT TOUCHES: `kind = 'REQUEST'` rows only, and only where the
-- column is still NULL — so it is idempotent, and a row the service
-- stamps between this migration's authoring and its application is
-- left alone. Soft-deleted rows are included; nothing reads them and
-- excluding them would be an opinion. The audit table is read once, in
-- full, by action: it has no index on `action`, and this is a one-off
-- pass over a small table, not a query the product will ever run.
--
-- `row_security = off` IS LOAD-BEARING, for the reason 20260906150000
-- records at length: `work_item` and `audit_event` are FORCE ROW LEVEL
-- SECURITY with policies `TO app_runtime`, so a migration role that is
-- not app_runtime matches no permissive policy and an UPDATE under RLS
-- would report success having changed NOTHING. With row_security off,
-- Postgres raises instead of quietly filtering: a no-op for a BYPASSRLS
-- owner, a failed migration for any other role. SET LOCAL, so it lasts
-- only for this migration's transaction.
--
-- CI migrates from an EMPTY database and this statement touches zero
-- rows there; the real rows it is for live on Neon. AGENTS.md's rule
-- for a migration carrying DML applies: a `neon-smoke.yml` dispatch,
-- read for its result, and recorded in PLAN §0.
SET LOCAL row_security = off;

UPDATE work_item AS w
   SET accepted_at = a.first_accepted_at
  FROM (
    SELECT e.tenant_id, e.target_id, MIN(e.created_at) AS first_accepted_at
      FROM audit_event AS e
     WHERE e.action = 'work_item.state_changed'
       AND e.target_type = 'WorkItem'
       AND e.metadata ->> 'from' IN ('TRIAGE', 'CANCELLED')
       AND e.metadata ->> 'to'   IN ('BACKLOG', 'TODO', 'IN_PROGRESS', 'DONE')
     GROUP BY e.tenant_id, e.target_id
  ) AS a
 WHERE w.tenant_id = a.tenant_id
   AND w.id = a.target_id
   AND w.kind = 'REQUEST'
   AND w.accepted_at IS NULL;

-- ── What this migration deliberately does NOT touch ─────────────────
--
-- NO RLS CHANGE, and it was checked rather than assumed. `work_item`'s
-- `portal_gate` (20260820170000) is
--
--   client_id = app.client_id AND visibility = 'CLIENT_VISIBLE'
--   AND portal_enabled
--
-- with no category term, so a cancelled client-visible request is
-- already readable by a contact — slice 6b showed it as Declined by a
-- projection change alone, and this slice tells Cancelled from Declined
-- by the same projection reading one more column of a row it already
-- holds. Nothing about WHICH rows a contact can reach changes.
--
-- NO GRANT: `work_item`'s is table-level (20260820170000), so the new
-- column is covered by the existing SELECT/INSERT/UPDATE/DELETE.
