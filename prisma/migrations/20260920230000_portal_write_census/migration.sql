-- Phase 3 slice 2 — THE CONTACT-WRITABLE CENSUS, ENFORCED.
--
-- TENANCY.md §7.2/§11, SECURITY.md §7 and AUTHZ.md §8 all state the
-- same closed set: a contact principal may write EXACTLY `Comment`
-- (INSERT), the `ProjectVersion` approval columns, the `Document`
-- approval columns, `Notification.readAt/archivedAt` on its own
-- receiver rows, and `ContinuityOpenRequest`. Everything else a contact
-- can cause is brokered under `withTenant(tenantId, {type:'system'})`.
--
-- THE DATABASE DID NOT SAY THAT. It was measured, not assumed:
-- `tenant_isolation` is PERMISSIVE **FOR ALL** on every class-B table,
-- and `portal_gate` is RESTRICTIVE with a WITH CHECK that only pins the
-- row to the contact's own client. On the tables whose WITH CHECK was
-- not written as an outright contact deny, the pair therefore ADMITS a
-- contact write. Concretely, before this migration a contact principal
-- could:
--
--   * INSERT a row into `contact` for its own client — a self-signup at
--     the data layer, the exact invariant slice 1 closed three ways on
--     the AUTH path (`disableSignUp`, the `portalAuthClient` refusal,
--     and no INSERT policy for the auth-path GUC). Those three all
--     defend the auth plane; none of them is in force inside an
--     ordinary contact-principal transaction.
--   * UPDATE its OWN `contact` row — including `portal_profile` to
--     CONTACT_PRIMARY and `portal_status`. `contact_auth_path_immutable`
--     does not cover this: that trigger keys on `app.auth_contact_id`,
--     which only src/db/portal-identity.ts ever sets.
--   * UPDATE `client`, `project`, `milestone`, `service`, `document`,
--     `project_version`, `project_time_summary`, `time_report` rows it
--     can see, and DELETE them — and DELETE a CLIENT_VISIBLE
--     `work_item` / `work_item_activity` (their portal_gate WITH CHECK
--     denies INSERT/UPDATE, but a DELETE is governed by USING alone,
--     and USING is the READ gate).
--
-- None of it was reachable: no application code has ever handed a
-- contact-principal transaction to a write. That is exactly why it
-- had to be closed BEFORE the slices that start handing contacts real
-- surfaces — RLS is the last line, and a last line that depends on the
-- application never making a mistake is not one.
--
-- WHAT THIS DOES. Three named RESTRICTIVE policies per class-B table —
-- `portal_no_insert` / `portal_no_update` / `portal_no_delete` — each
-- the same one-term predicate the rest of the schema uses. RESTRICTIVE
-- policies AND together, so these can only ever narrow; they cannot
-- widen anything and they do not touch SELECT.
--
-- Named, rather than folded into `portal_gate`'s WITH CHECK (which is
-- how `work_item` denies its writes today), because the census is a
-- TRIPWIRE and a tripwire has to be legible: `src/portal/census.dbtest.ts`
-- asserts the exact deny set per table against `pg_policies`, so a
-- future migration that opens a contact write must DROP a policy by
-- name and declare the carve-out in the census constant, in the same
-- commit, where a reviewer sees it. Folding it into a qual would have
-- made the same change a two-character edit inside a boolean.
--
-- `comment` is the ONE carve-out, because it is the one census entry
-- that exists today: its `portal_gate` WITH CHECK already spells out
-- the full contact-INSERT predicate (CLIENT_VISIBLE + own client +
-- author_contact_id = app.principal_id + portal_enabled) and it already
-- carries `portal_no_update` / `portal_no_delete`. It gets no
-- `portal_no_insert`.
--
-- The four census entries that do NOT exist yet — the two approval
-- column sets, the notification inbox flags (already correct: see
-- `principal_scope_update` + `portal_insert_deny` on `notification`)
-- and `ContinuityOpenRequest` (Phase 8, no table) — open their own door
-- in the commit that needs them. An approval path will drop
-- `portal_no_update` on its table and replace it with a policy plus a
-- column-level BEFORE UPDATE trigger, because Postgres column grants
-- are per-ROLE and every principal shares `app_runtime`: RLS alone
-- cannot say "these columns only".
--
-- `search_index` is deliberately untouched and is NOT a census entry in
-- the principal sense: its contact-satisfiable WITH CHECK exists for the
-- feed trigger that fires underneath the one permitted contact INSERT
-- (the comment). It is a trigger-caused write, already covered by the
-- comment's own predicate, and narrowing it here would break that path.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- B_clientScoped
    'client', 'contact',
    -- B_projectScoped (every one but `comment`)
    'project', 'project_version', 'milestone', 'service', 'document',
    'work_item', 'work_item_activity', 'project_time_summary', 'time_report'
  ] LOOP
    EXECUTE format($p$
      CREATE POLICY portal_no_insert ON %I
        AS RESTRICTIVE FOR INSERT TO app_runtime
        WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact')
    $p$, t);
    -- UPDATE and DELETE are denied through USING (the OLD row): a row a
    -- contact may not touch at all never reaches the WITH CHECK stage,
    -- and a USING-only deny is the shape `comment` already uses.
    EXECUTE format($p$
      CREATE POLICY portal_no_update ON %I
        AS RESTRICTIVE FOR UPDATE TO app_runtime
        USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact')
    $p$, t);
    EXECUTE format($p$
      CREATE POLICY portal_no_delete ON %I
        AS RESTRICTIVE FOR DELETE TO app_runtime
        USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact')
    $p$, t);
  END LOOP;
END
$$;
