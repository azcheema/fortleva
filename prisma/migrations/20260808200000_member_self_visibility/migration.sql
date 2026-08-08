-- "My tenants" self-visibility (identity is global, membership is
-- tenant-scoped — DATA_MODEL §1.1). The session layer must list a
-- user's own memberships BEFORE any tenant context exists; a third
-- transaction-local GUC (app.user_id, set only by withUser()) scopes
-- that lookup to exactly the caller's own rows. Unset GUC ⇒ NULL ⇒
-- zero rows: deny-default preserved.

CREATE POLICY member_self_select ON member
  FOR SELECT TO app_runtime
  USING (user_id = (SELECT current_setting('app.user_id', true)));

-- Tenant names for the tenant switcher: a tenant row is visible to a
-- user who has a membership in it. The EXISTS subquery is itself
-- RLS-filtered for app_runtime, so it can only ever match self rows.
CREATE POLICY tenant_member_select ON tenant
  FOR SELECT TO app_runtime
  USING (
    EXISTS (
      SELECT 1 FROM member
      WHERE member.tenant_id = tenant.id
        AND member.user_id = (SELECT current_setting('app.user_id', true))
    )
  );
