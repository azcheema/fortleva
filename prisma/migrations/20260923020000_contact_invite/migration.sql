-- ── The client portal's invitation ──────────────────────────────────
--
-- Phase 3, the invite slice. `Contact.portal_status` has existed since
-- Phase 2 and until now NOTHING IN THE PRODUCT WROTE IT — every contact
-- on every live tenant sits at the `NO_ACCESS` default, which is why no
-- client has ever been able to sign in and why slice 6c's hand-over
-- allowlist refused them all. This table is what moves that column.
--
-- IT IS THE CONTACT TWIN OF `member_invite` AND DELIBERATELY NOT THE
-- SAME TABLE. A member invitation names an EMAIL and creates the
-- `member` row on acceptance; a contact invitation names a ROW the
-- agency has already recorded, and acceptance only gives that row a
-- credential and flips its status. Folding the two together would mean
-- one table whose meaning depended on which column was null, on the one
-- pair of planes this product keeps apart by table identity.
--
-- RAW TOKENS NEVER TOUCH THE DATABASE: sha256 hash stored, the link
-- carries the token once (`src/members/invites.ts`'s rule, and the
-- reason `token_hash` is UNIQUE rather than the token itself).
--
-- CLASS A — `tenant_isolation` + `portal_deny`, registered in
-- `RLS_CLASSES.A`. A contact may never read this table: its rows name
-- other contacts of the same client, carry the inviting member's id,
-- and hold token hashes. Acceptance runs under the SYSTEM principal via
-- `withPlatform` — the acceptor has no session yet, exactly as member
-- acceptance does — so nothing here needs a portal gate and a gate
-- would be a promise this table must not make.
--
-- ON DELETE CASCADE from `contact`: deleting the record takes its
-- invitations with it, as it already takes credentials and sessions.
-- The FK is composite `(tenant_id, contact_id)` against `contact`'s
-- `(tenant_id, id)` unique, so an invitation cannot name a contact of
-- another tenant even before RLS is consulted.
--
-- DDL ONLY — no DML, so **no `neon-smoke` dispatch is owed**.

CREATE TABLE "contact_invite" (
  "id"                   TEXT         NOT NULL,
  "tenant_id"            TEXT         NOT NULL,
  "contact_id"           TEXT         NOT NULL,
  "token_hash"           TEXT         NOT NULL,
  "status"               "InviteStatus" NOT NULL DEFAULT 'PENDING',
  "invited_by_member_id" TEXT         NOT NULL,
  "expires_at"           TIMESTAMPTZ(6) NOT NULL,
  "accepted_at"          TIMESTAMPTZ(6),
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "contact_invite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contact_invite_token_hash_key" ON "contact_invite" ("token_hash");
-- The lookup behind "does this contact have a live invitation": the
-- issue path supersedes an open one, and the Contacts tab draws from it.
CREATE INDEX "contact_invite_tenant_id_contact_id_status_idx"
  ON "contact_invite" ("tenant_id", "contact_id", "status");
-- The sweep's key (Phase 8's purge job, and the age guard a future
-- expiry sweep will use), mirroring `member_invite`'s.
CREATE INDEX "contact_invite_expires_at_idx" ON "contact_invite" ("expires_at");

ALTER TABLE "contact_invite"
  ADD CONSTRAINT "contact_invite_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "contact_invite"
  ADD CONSTRAINT "contact_invite_tenant_id_contact_id_fkey"
  FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contact"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The runtime role. `app_runtime` is restricted and has no BYPASSRLS;
-- without this grant every statement against the table fails outright,
-- which is the failure mode this line exists to prevent.
GRANT SELECT, INSERT, UPDATE, DELETE ON "contact_invite" TO app_runtime;

ALTER TABLE "contact_invite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_invite" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "contact_invite"
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON "contact_invite"
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
