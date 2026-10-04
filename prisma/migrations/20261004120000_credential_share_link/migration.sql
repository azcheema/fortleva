-- ═══════════════════════════════════════════════════════════════════
-- Phase 3V slice 90 — SHARE LINKS: `credential_share_link` (class A).
-- DATA_MODEL.md §6.17; SECURITY.md's "Credential share links" row; CP4
-- (external share links ON: an emailed code, opened once, within 7 days);
-- founder decision C52 (k) (a client's door is a password AND an emailed
-- code — so a portal session alone opens no link either: every link asks
-- for the code).
--
-- WHAT IT IS. One row per link a member made: which login, which ONE of
-- its secret fields, the address the 6-digit code goes to, the secret's
-- version when shared, and when the link dies. The URL carries
-- `<tenantId>.<random>`; this table stores the sha256 of the random part
-- only (`token_hash`), so a dump of it opens nothing. A mailed code is
-- stored KEYED (HMAC under a server-held key, `shareCodeKey` in
-- src/config), never as a plain hash a dump could reverse. The value
-- itself is never here: it is decrypted from the login's secret at the
-- moment of viewing, and only while the secret is still `secret_version`.
--
-- WHO WRITES WHAT — and the guard below holds each to it:
--   * a MEMBER, as themselves, makes a link (INSERT; `created_by_member_id`
--     must be the transaction's own `app.principal_id`) and revokes one
--     (`revoked_at`, `revoked_by_member_id` — again their own id);
--   * the SYSTEM principal of the share page (`share-open.ts`, under
--     `withTenant(tenantId, {type:'system'})` — never `withPlatform`)
--     alone writes the code columns, the counters and `viewed_at`;
--   * no contact ever reads or writes it: CLASS A, tenant_isolation +
--     portal_deny.
-- Granted SELECT, INSERT, UPDATE — not DELETE. A row goes with its login
-- through the FK's cascade (a hard delete of the login: the 30-day purge,
-- a later job); the lasting evidence of a link is its audit rows
-- (`credential.shared|share_code_sent|share_code_refused|share_viewed|
-- share_revoked`), which outlive it. DATA_MODEL R2's "kept 12 months
-- after expiry" is the retention sweep's to honour when it is built, and
-- that job's migration adds the DELETE it needs.
--
-- WHAT THE DATABASE REFUSES, so that no writer — present or future — can
-- loosen what the service promises:
--   * a lifetime over 168 hours (`expires_at <= created_at + 168 hours`,
--     in HOURS, which are absolute — '7 days' would follow a session's
--     time zone across a daylight-saving change), and a `created_at` more
--     than five minutes from the statement that wrote it: the guard holds
--     it there at INSERT and never lets it move after, so the true bound
--     is 168 hours from within five minutes of the link's making;
--   * a send, a view or a revoke stamped at any time but its own (again
--     within five minutes of its statement), so the ten-minute code and
--     the view-before-expiry CHECKs below measure real moments;
--   * a new link that has already spent anything;
--   * more than 5 codes, or more than 5 code checks, on one link: the
--     brute-force bound is 5 guesses at a 6-digit code per LINK, ever;
--   * counters that go down, and a code's send time that goes back: no
--     writer can hand a link its guesses or its waits back;
--   * a code that lives past ten minutes, or a live code with no send;
--   * a view with no code checked, or after the link's expiry;
--   * a viewed or revoked link coming back: `viewed_at` and `revoked_at`
--     are one-way, and never both set;
--   * any change to what the link IS — its login, field, address,
--     version, token, expiry, creator, birth. (Both FKs say ON UPDATE
--     CASCADE, Prisma's default; a tenant's or login's id never changes,
--     so the guard turning such a cascade into an error costs nothing.)
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

-- CreateTable
CREATE TABLE "credential_share_link" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "include_username" BOOLEAN NOT NULL DEFAULT true,
    "recipient_email" TEXT NOT NULL,
    "secret_version" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "code_hash" TEXT,
    "code_expires_at" TIMESTAMPTZ(6),
    "code_sent_at" TIMESTAMPTZ(6),
    "codes_sent" INTEGER NOT NULL DEFAULT 0,
    "code_attempts" INTEGER NOT NULL DEFAULT 0,
    "viewed_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_member_id" TEXT,
    "created_by_member_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_share_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credential_share_link_token_hash_key" ON "credential_share_link"("token_hash");

-- CreateIndex
CREATE INDEX "credential_share_link_tenant_id_credential_id_created_at_idx" ON "credential_share_link"("tenant_id", "credential_id", "created_at");

-- CreateIndex
CREATE INDEX "credential_share_link_expires_at_idx" ON "credential_share_link"("expires_at");

-- AddForeignKey
ALTER TABLE "credential_share_link" ADD CONSTRAINT "credential_share_link_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_share_link" ADD CONSTRAINT "credential_share_link_tenant_id_credential_id_fkey" FOREIGN KEY ("tenant_id", "credential_id") REFERENCES "credential_item"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── CHECKs — the row's own shape ────────────────────────────────────
-- `field` is the closed set of secret field keys (`SECRET_FIELDS`,
-- src/modules/vault/fields.ts), restated so a later writer meets it too;
-- a new credential type with a new key widens
-- `credential_share_link_field` by name. The address pattern uses
-- `[:space:]`, not `\s`, so it means the same whatever
-- `standard_conforming_strings` says.
ALTER TABLE credential_share_link
  ADD CONSTRAINT credential_share_link_token_hash_shape
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT credential_share_link_field
    CHECK (field IN ('password', 'note', 'apiKey', 'apiSecret', 'privateKey', 'passphrase',
                     'connectionString', 'licenseKey', 'secret')),
  -- Lowercase, one `@` with something on both sides, no whitespace,
  -- within the length every address column in the product keeps.
  ADD CONSTRAINT credential_share_link_recipient_email
    CHECK (char_length(recipient_email) <= 320
           AND recipient_email = lower(recipient_email)
           AND recipient_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  ADD CONSTRAINT credential_share_link_secret_version_positive
    CHECK (secret_version >= 1),
  ADD CONSTRAINT credential_share_link_lifetime
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '168 hours'),
  ADD CONSTRAINT credential_share_link_code_hash_shape
    CHECK (code_hash IS NULL OR code_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT credential_share_link_code_pair
    CHECK ((code_hash IS NULL) = (code_expires_at IS NULL)),
  ADD CONSTRAINT credential_share_link_codes_sent_range
    CHECK (codes_sent BETWEEN 0 AND 5),
  ADD CONSTRAINT credential_share_link_code_attempts_range
    CHECK (code_attempts BETWEEN 0 AND 5),
  ADD CONSTRAINT credential_share_link_code_sent_pair
    CHECK ((codes_sent = 0) = (code_sent_at IS NULL)),
  -- A live code was sent, lives ten minutes from its send, and was sent
  -- while the link lived.
  ADD CONSTRAINT credential_share_link_code_was_sent
    CHECK (code_hash IS NULL OR codes_sent >= 1),
  ADD CONSTRAINT credential_share_link_code_lifetime
    CHECK (code_expires_at IS NULL
           OR (code_sent_at IS NOT NULL AND code_expires_at <= code_sent_at + interval '10 minutes')),
  ADD CONSTRAINT credential_share_link_code_sent_in_life
    CHECK (code_sent_at IS NULL OR code_sent_at < expires_at),
  -- A view took a code that was sent and checked, before the link expired,
  -- and leaves no live code behind.
  ADD CONSTRAINT credential_share_link_viewed_with_a_code
    CHECK (viewed_at IS NULL OR (codes_sent >= 1 AND code_attempts >= 1)),
  ADD CONSTRAINT credential_share_link_viewed_in_life
    CHECK (viewed_at IS NULL OR viewed_at < expires_at),
  ADD CONSTRAINT credential_share_link_viewed_holds_no_code
    CHECK (viewed_at IS NULL OR code_hash IS NULL),
  ADD CONSTRAINT credential_share_link_viewed_or_revoked
    CHECK (viewed_at IS NULL OR revoked_at IS NULL),
  ADD CONSTRAINT credential_share_link_revoked_pair
    CHECK ((revoked_at IS NULL) = (revoked_by_member_id IS NULL)),
  ADD CONSTRAINT credential_share_link_member_id_lengths
    CHECK (char_length(created_by_member_id) BETWEEN 1 AND 64
           AND (revoked_by_member_id IS NULL OR char_length(revoked_by_member_id) BETWEEN 1 AND 64));


-- ── The guard: who writes what; a link is born now and fresh; what it IS
-- cannot change; what it has spent cannot be given back; what it has
-- become cannot be undone ────────────────────────────────────────────
-- SECURITY INVOKER (the default): it reads nothing but its own row and
-- the transaction's GUCs. `IS DISTINCT FROM` so a NULL ↔ value change
-- counts as a change. Every refusal raises `CRED_SHARE_LINK_GUARD`, never
-- a value. The principal GUCs are the ones `withTenant` sets as its first
-- statement (`app.principal`, `app.principal_id`); unset — a platform or
-- owner connection — they are NULL/'' and match no rule that writes.
CREATE OR REPLACE FUNCTION credential_share_link_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A member makes a link, as themselves.
    IF who IS DISTINCT FROM 'member' OR who_id IS DISTINCT FROM NEW.created_by_member_id THEN
      RAISE EXCEPTION 'CRED_SHARE_LINK_GUARD: a share link is made by a member, as themselves';
    END IF;
    -- Born NOW: the lifetime CHECK measures from `created_at`, so a
    -- writer free to choose it could choose any lifetime. Five minutes of
    -- slack either side for a writer that stamps with its own clock.
    IF NEW.created_at < statement_timestamp() - interval '5 minutes'
       OR NEW.created_at > statement_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'CRED_SHARE_LINK_GUARD: a share link is made now';
    END IF;
    -- And fresh: nothing sent, checked, viewed or revoked yet.
    IF NEW.codes_sent <> 0 OR NEW.code_attempts <> 0
       OR NEW.code_hash IS NOT NULL OR NEW.code_expires_at IS NOT NULL OR NEW.code_sent_at IS NOT NULL
       OR NEW.viewed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.revoked_by_member_id IS NOT NULL THEN
      RAISE EXCEPTION 'CRED_SHARE_LINK_GUARD: a new share link has spent nothing';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE. What the link IS never changes.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.field IS DISTINCT FROM OLD.field
     OR NEW.include_username IS DISTINCT FROM OLD.include_username
     OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email
     OR NEW.secret_version IS DISTINCT FROM OLD.secret_version
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_by_member_id IS DISTINCT FROM OLD.created_by_member_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'CRED_SHARE_LINK_GUARD: a share link''s identity cannot change';
  END IF;
  -- What it has spent is never given back.
  IF NEW.codes_sent < OLD.codes_sent OR NEW.code_attempts < OLD.code_attempts
     OR (OLD.code_sent_at IS NOT NULL AND (NEW.code_sent_at IS NULL OR NEW.code_sent_at < OLD.code_sent_at)) THEN
    RAISE EXCEPTION 'CRED_SHARE_LINK_GUARD: a share link''s counters only go forward';
  END IF;
  -- What it has become is never undone.
  IF (OLD.viewed_at IS NOT NULL AND NEW.viewed_at IS DISTINCT FROM OLD.viewed_at)
     OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
                                         OR NEW.revoked_by_member_id IS DISTINCT FROM OLD.revoked_by_member_id)) THEN
    RAISE EXCEPTION 'CRED_SHARE_LINK_GUARD: a viewed or revoked share link stays so';
  END IF;
  -- Only the share page sends, checks and opens.
  IF (NEW.code_hash, NEW.code_expires_at, NEW.code_sent_at, NEW.codes_sent, NEW.code_attempts, NEW.viewed_at)
       IS DISTINCT FROM (OLD.code_hash, OLD.code_expires_at, OLD.code_sent_at, OLD.codes_sent, OLD.code_attempts, OLD.viewed_at)
     AND who IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'CRED_SHARE_LINK_GUARD: only the share page sends, checks or opens a link';
  END IF;
  -- A send, a view and a revoke are stamped when they happen — the CHECKs
  -- that bound a code's life and a view's moment compare these stamps, so
  -- a writer free to choose them could choose any life.
  IF (NEW.code_sent_at IS DISTINCT FROM OLD.code_sent_at
        AND (NEW.code_sent_at < statement_timestamp() - interval '5 minutes'
             OR NEW.code_sent_at > statement_timestamp() + interval '5 minutes'))
     OR (NEW.viewed_at IS DISTINCT FROM OLD.viewed_at
        AND (NEW.viewed_at < statement_timestamp() - interval '5 minutes'
             OR NEW.viewed_at > statement_timestamp() + interval '5 minutes'))
     OR (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
        AND (NEW.revoked_at < statement_timestamp() - interval '5 minutes'
             OR NEW.revoked_at > statement_timestamp() + interval '5 minutes')) THEN
    RAISE EXCEPTION 'CRED_SHARE_LINK_GUARD: a share link''s send, view and revoke are stamped now';
  END IF;
  -- Only a member revokes, as themselves.
  IF (NEW.revoked_at, NEW.revoked_by_member_id) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by_member_id)
     AND (who IS DISTINCT FROM 'member' OR who_id IS DISTINCT FROM NEW.revoked_by_member_id) THEN
    RAISE EXCEPTION 'CRED_SHARE_LINK_GUARD: a share link is revoked by a member, as themselves';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER credential_share_link_guard
  BEFORE INSERT OR UPDATE ON credential_share_link
  FOR EACH ROW EXECUTE FUNCTION credential_share_link_guard();


-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, UPDATE ON credential_share_link TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class A (portal_deny) ─────────────────────────────────────
ALTER TABLE credential_share_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_share_link FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON credential_share_link
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON credential_share_link
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
