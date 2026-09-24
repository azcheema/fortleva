-- ── The member plane's auth-mail ledger (C30) ─────────────────────────
--
-- Member account recovery re-opens two mails that slice 58 had closed: a
-- password-reset link, and a fresh confirmation link when an unconfirmed
-- member signs in with the right password. SECURITY.md §4 caps each at
-- three an hour PER RECIPIENT, counted in Postgres — the per-IP limiters
-- fail open until Upstash exists, and a flood aimed at one person's inbox
-- simply rotates addresses.
--
-- NEITHER MAIL CAN BE COUNTED WHERE IT LIVES, which is why this table
-- exists. A confirmation link is a JWT and writes no row anywhere. A reset
-- link is a row in `verification` — which also holds two-factor challenges
-- and trusted devices under the SAME user id, so the portal's
-- count-by-`value` would refuse a reset to anybody who signed in with a
-- second factor three times this hour. One row here per mail the member
-- plane has DECIDED to send; `src/auth/mail-budget.ts` takes the user row's
-- lock, counts on the database clock, and inserts or declines.
--
-- No token, no address, no link: a user id, a kind and a time.
--
-- AUTH CLASS, like `verification`: no tenant column (a person who has not
-- confirmed their address has no tenant), the allow_runtime/portal_deny
-- template, registered in MODEL_CLASSES.global and never exported with a
-- tenant. DDL only.

CREATE TYPE "AuthMailKind" AS ENUM ('PASSWORD_RESET', 'EMAIL_VERIFICATION');

CREATE TABLE "auth_mail" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" "AuthMailKind" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_mail_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "auth_mail_user_id_kind_created_at_idx" ON "auth_mail"("user_id", "kind", "created_at");

-- CASCADE, like every other auth table's key to `user`: deleting a person
-- takes their ledger with them, and nothing here is evidence anybody needs
-- after that.
ALTER TABLE "auth_mail" ADD CONSTRAINT "auth_mail_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Grants (deny-default) ────────────────────────────────────────────
-- No UPDATE: a ledger row is written once and deleted, never changed.
GRANT SELECT, INSERT, DELETE ON auth_mail TO app_runtime;

-- ── RLS: the AUTH-class template (see 20260808191500) ───────────────
ALTER TABLE auth_mail ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_mail FORCE ROW LEVEL SECURITY;

CREATE POLICY allow_runtime ON auth_mail
  AS PERMISSIVE FOR ALL TO app_runtime
  USING (true) WITH CHECK (true);

CREATE POLICY portal_deny ON auth_mail
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
