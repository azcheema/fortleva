-- ═══════════════════════════════════════════════════════════════════
-- Phase 3V slice 89 — THE RENEWAL REMINDERS' DEDUPE:
-- `expiration_reminder_sent` (class A). DATA_MODEL.md §6.17; founder
-- decisions C53 (who is reminded), C55 (agreements only when they END),
-- C56 (expiring logins, as a count per client).
--
-- WHAT IT IS. One row per reminder that went out: which subject (an
-- asset, an agreement, a login), the DAY it was about, and the band
-- (60 / 30 / 14 / 7 / 1 days before). The daily job inserts with ON
-- CONFLICT DO NOTHING, in the same transaction as the notification it
-- describes, so the primary key IS the dedupe: a conflict means "already
-- sent", and a reminder is never recorded without its inbox rows and
-- queued mail, nor queued without being recorded (the outbox then
-- delivers it).
--
-- `due_on` IS IN THE KEY, deliberately. A changed date re-arms by itself
-- — a renewed domain's new date has sent nothing — with no writer of the
-- subject (the Assets tab, an import, the continuity box) having to
-- clear rows here.
--
-- NO FOREIGN KEY TO THE SUBJECT: `subject_id` names a row of one of
-- three tables. Retention is the job's own sweep, which deletes a row once
-- its day has passed (it can no longer matter then: a passed date sends
-- nothing). A deleted subject's rows therefore go within about two months.
--
-- WHAT IT HOLDS: ids, a day, a number. No name, no secret — a login's
-- reminder row carries the login's id and its expiry day, which the
-- metadata row already holds; nothing of the vault's door is here.
--
-- CLASS A: tenant_isolation + portal_deny. No contact ever reads or
-- writes it. Granted SELECT, INSERT, DELETE — never UPDATE: a dedupe row
-- is written once and swept, and ON CONFLICT DO NOTHING needs INSERT only.
--
-- ALSO, FOLDED IN FROM SLICE 87's SECURITY REVIEW (recorded low): the two
-- url CHECKs missed a user/password after EXTRA slashes —
-- `https:///u:p@host` — which the service refuses (`normalizeUrl`) but a
-- later writer would not. See the last section for the pattern. In an ARE
-- a backslash stays special inside `[]`, hence `\\` (and `\t\n\r` are the
-- ARE's own escapes for tab, LF and CR).
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

-- CreateTable
CREATE TABLE "expiration_reminder_sent" (
    "tenant_id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "due_on" DATE NOT NULL,
    "offset_days" INTEGER NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expiration_reminder_sent_pkey" PRIMARY KEY ("tenant_id","subject_type","subject_id","due_on","offset_days")
);

-- CreateIndex
CREATE INDEX "expiration_reminder_sent_tenant_id_due_on_idx" ON "expiration_reminder_sent"("tenant_id", "due_on");

-- AddForeignKey
ALTER TABLE "expiration_reminder_sent" ADD CONSTRAINT "expiration_reminder_sent_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── CHECKs — the row's own shape ────────────────────────────────────
-- The service's closed sets (the subject types in
-- src/modules/vault/reminders.ts, the bands in `REMINDER_BANDS`,
-- reminder-bands.ts), restated so a later writer meets them too. A new subject (the `Contract` of a later
-- phase) widens `expiration_reminder_sent_subject_type` by name.
ALTER TABLE expiration_reminder_sent
  ADD CONSTRAINT expiration_reminder_sent_subject_type
    CHECK (subject_type IN ('ClientAsset', 'Service', 'CredentialItem')),
  ADD CONSTRAINT expiration_reminder_sent_offset_days
    CHECK (offset_days IN (60, 30, 14, 7, 1)),
  ADD CONSTRAINT expiration_reminder_sent_subject_id_length
    CHECK (char_length(subject_id) BETWEEN 1 AND 64);

-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, DELETE ON expiration_reminder_sent TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class A (portal_deny) ─────────────────────────────────────
ALTER TABLE expiration_reminder_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE expiration_reminder_sent FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON expiration_reminder_sent
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON expiration_reminder_sent
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');


-- ── The url CHECKs, tightened (slice 87's security review) ──────────
-- `client_asset_url_http` refused `https://u:p@host`; it now refuses
-- `https:///u:p@host` too. `credential_item_url_http` checked the scheme
-- only; it now refuses both. `normalizeUrl` (src/modules/vault/fields.ts,
-- shared by both tables) refuses the SAME pattern first, with a message.
--
-- The pattern: after the scheme's colon, any run of `/`, `\`, tab, LF or
-- CR (a URL parser treats `\` as `/` and strips tabs and newlines, so
-- `https://<TAB>/u:p@host` is `https:///u:p@host` to a browser), then
-- anything but `/`, `?` or `#` up to an `@`. A backslash INSIDE that run
-- does not end it, so `https://a\@host` is refused as before — the new
-- pattern matches everything the old `^[A-Za-z]+://[^/?#]*@` did (the
-- pre-apply review's medium: a first draft let it through). An `@` in the
-- path, query or fragment (`https://medium.com/@acme`) still passes.
-- Probed on Postgres before this was applied: 18 cases, as intended. The
-- literal assumes `standard_conforming_strings = on` (the default since 9.1,
-- and so on Neon and the CI container; the probe confirmed it on dev).
--
-- A plain ADD: the whole script is one transaction, so `NOT VALID` then
-- `VALIDATE` would hold the same lock to the same commit (the review).
-- Both tables are small; every dev row was counted against the pattern
-- first (zero fail). Count again on any other database before deploying
-- there — a failing row aborts the migration whole, and `migrate deploy`
-- then waits on `prisma migrate resolve`.
ALTER TABLE client_asset DROP CONSTRAINT client_asset_url_http;
ALTER TABLE client_asset
  ADD CONSTRAINT client_asset_url_http
    CHECK (url IS NULL OR (url ~* '^https?://' AND url !~ '^[A-Za-z]+:[/\\\t\n\r]*[^/?#]*@'));

ALTER TABLE credential_item DROP CONSTRAINT credential_item_url_http;
ALTER TABLE credential_item
  ADD CONSTRAINT credential_item_url_http
    CHECK (url IS NULL OR (url ~* '^https?://' AND url !~ '^[A-Za-z]+:[/\\\t\n\r]*[^/?#]*@'));
