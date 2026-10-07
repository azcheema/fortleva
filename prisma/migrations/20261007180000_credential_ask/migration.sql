-- ═══════════════════════════════════════════════════════════════════
-- Phase 3V slice 98 — THE AGENCY ASKS A CLIENT FOR A NAMED LOGIN
-- (founder decision C66, 2026-10-07; C64 (a)'s later slice, built on slice
-- 96's hand-over). DATA_MODEL.md §6.17; AUTHZ.md §4, §8.
--
-- ONE TABLE, `credential_ask` (class A). One row per ask:
--   - a MEMBER who may add a login there (`credential:create`, the vault's
--     anchor reach, through the vault's door — C66 (d)) asks ONE contact of
--     the client (a main contact or a helper — C66 (a)) for something they
--     need, by a name and an optional note. BOTH ARE SHOWN TO THAT CONTACT:
--     the form says so. The contact is mailed once (C66 (b));
--   - the contact SENDS it — a slice-96 hand-over, anchored where the ASK
--     says (the portal's broker, as SYSTEM) — or DECLINES it with a short
--     note the team reads (C66 (c), the same broker);
--   - or a member CANCELS it.
--   Exactly one of the three ends it, once; nothing expires.
--
-- WHO WRITES WHAT — `credential_ask_guard`. It holds who acts and what
-- each act may name, for any writer; it does NOT restate everything the
-- services check (for SYSTEM: the contact's portal profile, the agency's
-- "Logins sent by clients" switch, the modules, the per-person bounds, the
-- project's portal and archive, the client's archive — those are the
-- broker's and `asks.ts`'s, and a new writer must restate them):
--   - A MEMBER, as themselves: the ask (INSERT) and a cancellation — and
--     only an ACTIVE member who holds `credential:create` through a role,
--     read exactly as `effectivePermissions` reads it (slice 93's guard's
--     join). The application also wants the vault's door (a fresh factor),
--     the module gates and the member's scope over the anchor; the database
--     keeps the permission. The asked contact must be an ACTIVE, invited
--     contact OF THAT CLIENT, whose row the guard reads `FOR SHARE` (ending
--     their access waits for the ask to commit, or the ask waits and then
--     refuses); a project must be the same client's.
--   - SYSTEM (the portal's broker): a SEND — naming a login of this
--     tenant and client, on the ask's own project (or none), handed over
--     by THE ASKED CONTACT in this same transaction, not binned — or a
--     DECLINE by the asked contact, still an active, invited contact of
--     the client, whose row it holds `FOR SHARE`.
--   - Nobody else: a contact principal reads and writes nothing here
--     (class A: `portal_deny`); a platform or owner connection, whose GUCs
--     are unset, matches no rule that writes.
--   What was asked, of whom, by whom and when never changes; an ask ends
--   once, and one login answers at most one ask (a partial UNIQUE). Every
--   refusal raises a token and never a value: `CREDENTIAL_ASK_CONTACT` (the
--   contact is not, or no longer, one who may be asked or decline) and
--   `CREDENTIAL_ASK_ENDED` (an act on an ask that has ended) — the two a
--   lost race can meet, which the services turn into typed refusals
--   (the design review's nit) — and `CREDENTIAL_ASK_GUARD` for the rest,
--   which no product path reaches.
--
-- TIME: `created_at` and every act's stamp are the APPLICATION's clock
-- (Prisma's `@default(now())` and `new Date()`), held to the statement's
-- start within five minutes either way, as slice 96's guard holds a
-- hand-over's `created_at`. There is deliberately NO "an act comes after
-- the ask" CHECK: two stamps from two application instances can disagree
-- by seconds, and an ask cancelled at once by an instance whose clock is
-- behind would fail as an unmapped CHECK violation (the pre-apply
-- review's nit).
--
-- Granted SELECT, INSERT, UPDATE — no DELETE: a row goes with its client,
-- its project or its contact (FK cascade; referential actions run as the
-- table owner). A DECLINED ask is the contact's writing
-- (`declined_by_contact_id`, attribution), and `deleteContact` — the
-- product's one way to delete a contact — refuses one who has written
-- anything, so through it only an unanswered or cancelled ask, or a sent
-- one whose login still exists (and so blocks that delete too), goes by
-- the contact cascade. A platform or owner connection deleting a contact
-- directly (a fixture's teardown, a future erasure) cascades every ask.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

-- CreateTable
CREATE TABLE "credential_ask" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "project_id" TEXT,
    "contact_id" TEXT NOT NULL,
    "type" "credential_type" NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "requested_by_member_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),
    "sent_credential_id" TEXT,
    "declined_at" TIMESTAMPTZ(6),
    "declined_by_contact_id" TEXT,
    "decline_note" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_member_id" TEXT,

    CONSTRAINT "credential_ask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credential_ask_tenant_id_client_id_created_at_idx" ON "credential_ask"("tenant_id", "client_id", "created_at");

-- CreateIndex
CREATE INDEX "credential_ask_tenant_id_contact_id_created_at_idx" ON "credential_ask"("tenant_id", "contact_id", "created_at");

-- CreateIndex
CREATE INDEX "credential_ask_tenant_id_project_id_idx" ON "credential_ask"("tenant_id", "project_id");

-- One login answers at most one ask (the design review's low): the guard
-- holds that a send names a login the asked contact handed over in this
-- transaction; this holds that no second ask can name the same one.
CREATE UNIQUE INDEX credential_ask_sent_credential_unique
  ON credential_ask (tenant_id, sent_credential_id)
  WHERE sent_credential_id IS NOT NULL;

-- AddForeignKey
ALTER TABLE "credential_ask" ADD CONSTRAINT "credential_ask_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_ask" ADD CONSTRAINT "credential_ask_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_ask" ADD CONSTRAINT "credential_ask_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_ask" ADD CONSTRAINT "credential_ask_tenant_id_contact_id_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contact"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── CHECKs — the row's own shape ────────────────────────────────────
ALTER TABLE credential_ask
  -- What the team writes, and the client reads: never blank, bounded.
  ADD CONSTRAINT credential_ask_name_length
    CHECK (char_length(name) BETWEEN 1 AND 200 AND name ~ '[^[:space:]]'),
  ADD CONSTRAINT credential_ask_note_length
    CHECK (note IS NULL OR (char_length(note) BETWEEN 1 AND 1000 AND note ~ '[^[:space:]]')),
  ADD CONSTRAINT credential_ask_id_lengths
    CHECK (    char_length(requested_by_member_id) BETWEEN 1 AND 64
           AND (sent_credential_id IS NULL OR char_length(sent_credential_id) BETWEEN 1 AND 64)
           AND (declined_by_contact_id IS NULL OR char_length(declined_by_contact_id) BETWEEN 1 AND 64)
           AND (cancelled_by_member_id IS NULL OR char_length(cancelled_by_member_id) BETWEEN 1 AND 64)),
  -- Each act is a stamp AND what it names, or neither.
  ADD CONSTRAINT credential_ask_sent_pair
    CHECK ((sent_at IS NULL) = (sent_credential_id IS NULL)),
  ADD CONSTRAINT credential_ask_declined_pair
    CHECK ((declined_at IS NULL) = (declined_by_contact_id IS NULL)),
  ADD CONSTRAINT credential_ask_cancelled_pair
    CHECK ((cancelled_at IS NULL) = (cancelled_by_member_id IS NULL)),
  -- Only the person asked declines it (C66 (a)).
  ADD CONSTRAINT credential_ask_declined_by_asked
    CHECK (declined_by_contact_id IS NULL OR declined_by_contact_id = contact_id),
  -- A decline's note goes with the decline, and is the team's to read.
  ADD CONSTRAINT credential_ask_decline_note
    CHECK (decline_note IS NULL
           OR (declined_at IS NOT NULL AND char_length(decline_note) BETWEEN 1 AND 500 AND decline_note ~ '[^[:space:]]')),
  -- An ask ends ONE way: sent, declined or cancelled.
  ADD CONSTRAINT credential_ask_one_ending
    CHECK (num_nonnulls(sent_at, declined_at, cancelled_at) <= 1);


-- ── The guard ───────────────────────────────────────────────────────
-- SECURITY INVOKER (the default): it reads the transaction's GUCs and the
-- member's, contact's, project's and login's rows, each under the writer's
-- own RLS, which for SYSTEM and for a member of this tenant admits this
-- tenant's rows. (Every FK says ON UPDATE CASCADE, Prisma's default; no
-- id it points at ever changes, so the guard turning such a cascade into
-- an error costs nothing.)
CREATE OR REPLACE FUNCTION credential_ask_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
  at timestamptz := statement_timestamp();
  slack constant interval := interval '5 minutes';
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- THE ASK: a member, as themselves, made now, with nothing but itself.
    IF who IS DISTINCT FROM 'member' OR NEW.requested_by_member_id IS DISTINCT FROM who_id THEN
      RAISE EXCEPTION 'CREDENTIAL_ASK_GUARD: a member asks, as themselves';
    END IF;
    IF NEW.created_at < at - slack OR NEW.created_at > at + slack THEN
      RAISE EXCEPTION 'CREDENTIAL_ASK_GUARD: an ask is made now';
    END IF;
    IF num_nonnulls(NEW.sent_at, NEW.sent_credential_id, NEW.declined_at, NEW.declined_by_contact_id,
                    NEW.decline_note, NEW.cancelled_at, NEW.cancelled_by_member_id) <> 0 THEN
      RAISE EXCEPTION 'CREDENTIAL_ASK_GUARD: a new ask has nothing but itself';
    END IF;
    -- …who may add a login (C66 (d)), read as `effectivePermissions` reads
    -- it (a TENANT_REVOKE row grants nothing).
    IF NOT EXISTS (SELECT 1
                     FROM member m
                     JOIN member_role mr ON mr.tenant_id = m.tenant_id AND mr.member_id = m.id
                     JOIN role_permission rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
                     JOIN permission p ON p.id = rp.permission_id
                    WHERE m.tenant_id = NEW.tenant_id AND m.id = who_id AND m.status = 'ACTIVE'
                      AND rp.source <> 'TENANT_REVOKE' AND p.code = 'credential:create') THEN
      RAISE EXCEPTION 'CREDENTIAL_ASK_GUARD: only a member who may add a login asks for one';
    END IF;
    -- …of an ACTIVE, invited contact OF THIS CLIENT (C66 (a)), whose row is
    -- held so ending their access waits for this ask, or this ask for it.
    PERFORM 1 FROM contact c
      WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.contact_id AND c.client_id = NEW.client_id
        AND c.portal_status = 'ACTIVE' AND c.invited_at IS NOT NULL
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CREDENTIAL_ASK_CONTACT: only an active contact of the client is asked';
    END IF;
    -- …for that client, or one of its projects.
    IF NEW.project_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM project p
                        WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id AND p.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'CREDENTIAL_ASK_GUARD: a project of the same client';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE. What was asked, of whom, by whom and when never changes.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.requested_by_member_id IS DISTINCT FROM OLD.requested_by_member_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'CREDENTIAL_ASK_GUARD: what was asked cannot change';
  END IF;
  -- An ask ends once, and nothing else about it is ever written: every
  -- UPDATE is that one ending, of an ask that is still open.
  IF num_nonnulls(OLD.sent_at, OLD.declined_at, OLD.cancelled_at) <> 0 THEN
    RAISE EXCEPTION 'CREDENTIAL_ASK_ENDED: an ask ends once';
  END IF;

  IF who = 'member' THEN
    -- A CANCELLATION, as themselves, made now, by a member who may ask.
    IF NEW.cancelled_at IS NULL
       OR NEW.cancelled_by_member_id IS DISTINCT FROM who_id
       OR NEW.cancelled_at < at - slack OR NEW.cancelled_at > at + slack
       OR num_nonnulls(NEW.sent_at, NEW.sent_credential_id, NEW.declined_at, NEW.declined_by_contact_id, NEW.decline_note) <> 0 THEN
      RAISE EXCEPTION 'CREDENTIAL_ASK_GUARD: a member only cancels an ask, as themselves, now';
    END IF;
    IF NOT EXISTS (SELECT 1
                     FROM member m
                     JOIN member_role mr ON mr.tenant_id = m.tenant_id AND mr.member_id = m.id
                     JOIN role_permission rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
                     JOIN permission p ON p.id = rp.permission_id
                    WHERE m.tenant_id = NEW.tenant_id AND m.id = who_id AND m.status = 'ACTIVE'
                      AND rp.source <> 'TENANT_REVOKE' AND p.code = 'credential:create') THEN
      RAISE EXCEPTION 'CREDENTIAL_ASK_GUARD: only a member who may add a login cancels an ask';
    END IF;
    RETURN NEW;
  END IF;

  IF who IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'CREDENTIAL_ASK_GUARD: an ask is ended by a member who cancels it or by the portal''s broker';
  END IF;

  -- SYSTEM never cancels.
  IF NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by_member_id IS NOT NULL THEN
    RAISE EXCEPTION 'CREDENTIAL_ASK_GUARD: only a member cancels an ask';
  END IF;

  IF NEW.sent_at IS NOT NULL THEN
    -- A SEND: the login it became — this tenant's, this client's, on the
    -- ask's own project (or none), handed over by THE ASKED CONTACT, live,
    -- and written IN THIS TRANSACTION (its row's `xmin` is this
    -- transaction's id — measured on PG 18.6 before this was written),
    -- so the hand-over's own guard on `credential_item` — an active,
    -- invited contact of the client, held `FOR SHARE` — has just held for
    -- it. Never a login sent earlier, re-linked (the pre-apply review's
    -- low: a five-minute window would have admitted one). The product
    -- writes the login and the send in one interactive transaction with
    -- no savepoint, so the row's `xmin` is the top-level id compared here.
    IF NEW.sent_at < at - slack OR NEW.sent_at > at + slack THEN
      RAISE EXCEPTION 'CREDENTIAL_ASK_GUARD: a send is recorded now';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM credential_item ci
                    WHERE ci.tenant_id = NEW.tenant_id AND ci.id = NEW.sent_credential_id
                      AND ci.client_id = NEW.client_id
                      AND ci.project_id IS NOT DISTINCT FROM NEW.project_id
                      AND ci.submitted_by_contact_id = NEW.contact_id
                      AND ci.deleted_at IS NULL
                      AND ci.xmin = pg_current_xact_id()::xid) THEN
      RAISE EXCEPTION 'CREDENTIAL_ASK_GUARD: a send names the login the asked contact handed over in this transaction';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.declined_at IS NOT NULL THEN
    -- A DECLINE: by the asked contact (the CHECK), made now, still an
    -- active, invited contact of the client — whose row is held `FOR
    -- SHARE`, as the INSERT branch holds it (the pre-apply review's low):
    -- ending their access, and so `deleteContact`, then waits for the
    -- decline to commit and counts it, for any writer. The portal's broker
    -- already holds this lock (`submitterStanding`), so it adds no wait.
    -- A writer of a decline takes the contact's row BEFORE the ask's, as the
    -- broker does: `deleteContact` takes the contact, then (by its cascade)
    -- the ask, and the other order would be a deadlock.
    IF NEW.declined_at < at - slack OR NEW.declined_at > at + slack THEN
      RAISE EXCEPTION 'CREDENTIAL_ASK_GUARD: a decline is recorded now';
    END IF;
    PERFORM 1 FROM contact c
      WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.declined_by_contact_id
        AND c.client_id = NEW.client_id
        AND c.portal_status = 'ACTIVE' AND c.invited_at IS NOT NULL
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CREDENTIAL_ASK_CONTACT: a decline is the asked contact''s, while they have access';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'CREDENTIAL_ASK_GUARD: an UPDATE of an ask is its one ending';
END
$fn$;
CREATE TRIGGER credential_ask_guard
  BEFORE INSERT OR UPDATE ON credential_ask
  FOR EACH ROW EXECUTE FUNCTION credential_ask_guard();


-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, UPDATE ON credential_ask TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class A (portal_deny) ─────────────────────────────────────
ALTER TABLE credential_ask ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_ask FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON credential_ask
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON credential_ask
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
