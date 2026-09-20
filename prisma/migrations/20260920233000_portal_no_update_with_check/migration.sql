-- THE CONTACT-WRITE DENY MUST BE A `WITH CHECK`, NEVER A `USING` —
-- because a RESTRICTIVE `FOR UPDATE ... USING` also silences
-- `SELECT ... FOR SHARE`, and that is how the previous migration broke
-- the ONE write it was written to protect.
--
-- WHAT HAPPENED, measured rather than reasoned about. Migration
-- `20260920230000` closed the contact-write holes with three policies
-- per class-B table, and wrote the UPDATE one as a USING deny — the
-- shape `comment` has carried since 2W. `census.dbtest.ts`'s POSITIVE
-- CONTROL then failed: a contact could no longer insert a comment at
-- all, with `COMMENT_SUBJECT_GONE: comment subject not found in
-- tenant`. The subject was there, and a plain SELECT under the same
-- principal returned it:
--
--   plain SELECT           => [{ id: … }]
--   SELECT … FOR SHARE     => []
--
-- `comment_denorm_guard` reads its subject `FOR SHARE` (migration
-- 20260915120000, the comment write-skew fix), and **Postgres applies
-- the UPDATE policies to a row lock**: `SELECT … FOR UPDATE/FOR SHARE`
-- checks the UPDATE USING clause as well as the SELECT one. A
-- RESTRICTIVE UPDATE deny therefore makes every row of that table
-- UNLOCKABLE by a contact — which reads to the guard as "the subject
-- does not exist", the same as a cross-tenant id.
--
-- Nothing in the schema would have said so, and no structural test
-- could have: the policy set was exactly as intended, the census pin
-- passed, and every denial test passed harder than before. Only the
-- positive control — the assertion that the permitted write still WORKS
-- — could see it. A deny-matrix without a positive control measures
-- whether the database is reachable at all.
--
-- THE FIX, and why it is uniform. `portal_no_update` becomes WITH CHECK
-- only, with no USING:
--
--   * a row lock consults the UPDATE **USING** clause, which is now
--     absent (⇒ unrestricted), so `FOR SHARE` works again;
--   * an actual UPDATE must satisfy the **WITH CHECK** on the new row,
--     which a contact never can, so the write is refused exactly as
--     before — loudly, as 42501, instead of silently as zero rows
--     matched.
--
-- It is the same shape `work_item`'s `portal_gate` has always used, and
-- reading THAT is what explains why 2W wrote it that way. Applied to
-- every table rather than only to the ones a contact-caused path
-- happens to lock today (`work_item` through the comment guard,
-- `document` through its DOCUMENT and FILE_VERSION branches), because
-- "which tables does a contact path lock?" is a list that grows —
-- a portal comment on a `project_version` or a deliverable adds to it —
-- and a rule that has to be remembered per table is a rule that will be
-- got wrong.
--
-- `portal_no_delete` stays a USING deny: DELETE has no WITH CHECK, and
-- a row lock consults UPDATE policies only, so it costs nothing.
-- `comment`'s own pre-existing `portal_no_update` is deliberately left
-- alone — it is the one table whose rows no contact-caused path locks,
-- and it has shipped and been tested in that shape since 2W.
--
-- ONE CORRECTION TO THE PREVIOUS MIGRATION'S HEADER, which cannot be
-- edited now that it is applied: it says Postgres column grants "are
-- per-ROLE and every principal shares `app_runtime`", implying they are
-- no use here. The first half is true and the conclusion is too narrow.
-- `notification` already uses one — `GRANT UPDATE (read_at,
-- archived_at, snoozed_till)` — and it is the right tool wherever NO
-- principal may write the other columns. It cannot express "a contact
-- may write only these columns" while a member writes others; that
-- still needs a trigger. The approval-column slices should reach for
-- the grant first and add the trigger only for the per-principal half.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'client', 'contact',
    'project', 'project_version', 'milestone', 'service', 'document',
    'work_item', 'work_item_activity', 'project_time_summary', 'time_report'
  ] LOOP
    EXECUTE format('DROP POLICY portal_no_update ON %I', t);
    EXECUTE format($p$
      CREATE POLICY portal_no_update ON %I
        AS RESTRICTIVE FOR UPDATE TO app_runtime
        WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact')
    $p$, t);
  END LOOP;
END
$$;
