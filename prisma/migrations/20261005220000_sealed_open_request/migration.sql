-- ═══════════════════════════════════════════════════════════════════
-- Phase 3V slice 93 — THE CLIENT'S ASK AND THE WAIT (founder decisions
-- C52 (f)–(j), C61): a client asks to open the logins their agency keeps
-- SEALED for them (slice 92), and either somebody at the agency answers or
-- the time does. DATA_MODEL.md §6.17; SECURITY.md §6.3; AUTHZ.md §3.2, §8.
--
-- ONE TABLE, `sealed_open_request` (class A). One row per ask:
--   - a MAIN contact of the client asks, with their portal password and a
--     reason (the portal's vault broker, as SYSTEM — the password is
--     checked by the application, before this row exists);
--   - whoever holds `credential:unseal` APPROVES — it opens at once, for
--     7 days — or DENIES, with a reason the client is shown; the client
--     may ask again 30 days after a denial. Either answer is possible
--     until the moment it opens (C61 (c)), and only then;
--   - after `wait_days` of silence (the agency's `vault.sealedWaitDays`,
--     7 to 60, FROZEN on the row when the ask is made) the client
--     CONFIRMS — with their password AND a code mailed to them, which is
--     the client's door of slice 91 opened just before — and it opens 48
--     hours later (C52 (f)'s "opens in 48 hours"). A confirmation not made
--     within 30 days after the wait LAPSES the ask;
--   - a main contact may WITHDRAW an ask that has not opened yet.
--   Once open, the client's main contacts see the sealed logins behind
--   their door for 7 days, every look audited, and then it locks again
--   (C52 (h)). Nothing here unseals a login.
--
-- THE STATE IS DERIVED AT READ TIME from these stamps
-- (`src/lib/ask-and-wait.ts`, the one ask-and-wait machine C52 (j) says
-- the continuity box will reuse): waiting, confirmable, opening, open,
-- closed, denied, withdrawn, lapsed. No column says "open" and no job
-- opens anything — the daily job (`src/jobs/sealed-requests.ts`) only
-- MAILS, and records what it mailed — so a missed run never delays or
-- extends an opening.
--
-- TIME. Every interval below is in HOURS (7 days = 168 hours, 30 days =
-- 720 hours): an interval of days added to a timestamptz depends on the
-- session's TimeZone across a daylight-saving change, and hours do not.
-- `src/modules/vault/sealed-rules.ts` holds the same four figures and
-- `sealed-rules.test.ts` pins them to this file. A stamp is never later
-- than its statement's start (`statement_timestamp()`) and at most five
-- minutes earlier — the product's writers stamp with the database's own
-- clock, read a statement before — so a stamp can move an opening or a
-- deadline by those five minutes at most, and only earlier: the accepted
-- tolerance. The DEADLINES an act must beat (the opening, the lapse) are
-- judged on `clock_timestamp()` read inside the guard AFTER the row lock
-- and the client's ask lock, never on the statement's start, which a
-- statement queued behind a look or an ask could hold from before them.
--
-- WHO WRITES WHAT — `sealed_open_request_guard`, so no writer present or
-- future can loosen what the services promise:
--   - SYSTEM (the portal's vault broker; the daily job): the ask
--     (INSERT), the confirmation, a withdrawal, and the mail bookkeeping
--     (`reminders_sent`, `last_reminded_at`, `opened_notice_at`). The
--     contact named on an ask, a confirmation or a withdrawal must be an
--     ACTIVE, invited MAIN contact of the client (C61 (e)). The wait on a
--     new ask must be the agency's `vault.sealedWaitDays` as it stands
--     (C52 (g)), read as the application reads it. A confirmation needs a
--     client door of that contact (`contact_vault_unlock`) opened after
--     the wait ran out and open now — which the broker writes only after
--     their password and a mailed code (C52 (f)). The door table is
--     SYSTEM's too, so this binds a mistaken caller, not a hostile SYSTEM
--     writer, which could make the door itself.
--   - A MEMBER, as themselves: an approval or a denial, and nothing else
--     — and only an ACTIVE member who holds `credential:unseal` through
--     a role (C61 (f): it follows the roles, owners by default), read
--     exactly as `effectivePermissions` reads it. The application also
--     wants a fresh authenticator code for an approval (CP4) and the
--     member's scope over the client; the database keeps the permission.
--   - Nobody else: a contact principal reads and writes nothing here
--     (class A: `portal_deny`); a platform or owner connection, whose
--     GUCs are unset, matches no rule that writes.
--   One live ask per client and the 30-day cool-down after a denial are
--   checked under a per-client advisory lock
--   (`sealed_open_request:<tenant>:<client>`; the key space every
--   `hashtext` advisory lock shares, `src/modules/vault/budget.ts`),
--   which every ask, answer, confirmation and withdrawal takes — the
--   application before the row's lock, the guard again (re-entrant) — so
--   an ask and an ending act on another ask of the same client are judged
--   one after the other, never across the lapse instant. What
--   was asked, by whom, when, and for how long the wait runs never
--   change; every answer, confirmation and withdrawal is one-way; a
--   denial or withdrawal clears the scheduled opening.
--   Granted SELECT, INSERT, UPDATE — no DELETE: a row goes with its
--   client (FK cascade); the lasting evidence is the audit trail.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

-- CreateTable
CREATE TABLE "sealed_open_request" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "asked_by_contact_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "wait_days" INTEGER NOT NULL,
    "asked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),
    "confirmed_by_contact_id" TEXT,
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_member_id" TEXT,
    "denied_at" TIMESTAMPTZ(6),
    "denied_by_member_id" TEXT,
    "deny_reason" TEXT,
    "withdrawn_at" TIMESTAMPTZ(6),
    "withdrawn_by_contact_id" TEXT,
    "opens_at" TIMESTAMPTZ(6),
    "open_until" TIMESTAMPTZ(6),
    "reminders_sent" INTEGER NOT NULL DEFAULT 0,
    "last_reminded_at" TIMESTAMPTZ(6),
    "opened_notice_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sealed_open_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sealed_open_request_tenant_id_client_id_asked_at_idx" ON "sealed_open_request"("tenant_id", "client_id", "asked_at");

-- AddForeignKey
ALTER TABLE "sealed_open_request" ADD CONSTRAINT "sealed_open_request_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sealed_open_request" ADD CONSTRAINT "sealed_open_request_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── CHECKs — the row's own shape ────────────────────────────────────
ALTER TABLE sealed_open_request
  ADD CONSTRAINT sealed_open_request_reason_length
    CHECK (char_length(reason) BETWEEN 1 AND 1000 AND reason ~ '[^[:space:]]'),
  ADD CONSTRAINT sealed_open_request_wait_days_range
    CHECK (wait_days BETWEEN 7 AND 60),
  ADD CONSTRAINT sealed_open_request_contact_id_length
    CHECK (char_length(asked_by_contact_id) BETWEEN 1 AND 64),
  -- Each act is a stamp AND who did it, or neither.
  ADD CONSTRAINT sealed_open_request_confirmed_pair
    CHECK ((confirmed_at IS NULL) = (confirmed_by_contact_id IS NULL)),
  ADD CONSTRAINT sealed_open_request_approved_pair
    CHECK ((approved_at IS NULL) = (approved_by_member_id IS NULL)),
  ADD CONSTRAINT sealed_open_request_denied_pair
    CHECK ((denied_at IS NULL) = (denied_by_member_id IS NULL)),
  ADD CONSTRAINT sealed_open_request_withdrawn_pair
    CHECK ((withdrawn_at IS NULL) = (withdrawn_by_contact_id IS NULL)),
  -- A denial's reason goes with the denial, and is the client's to read.
  ADD CONSTRAINT sealed_open_request_deny_reason
    CHECK (deny_reason IS NULL
           OR (denied_at IS NOT NULL AND char_length(deny_reason) BETWEEN 1 AND 1000 AND deny_reason ~ '[^[:space:]]')),
  -- An ask ends ONE way: approved, denied or withdrawn.
  ADD CONSTRAINT sealed_open_request_one_ending
    CHECK (num_nonnulls(approved_at, denied_at, withdrawn_at) <= 1),
  -- Every act comes after the ask.
  ADD CONSTRAINT sealed_open_request_acts_after_ask
    CHECK (    (confirmed_at IS NULL OR confirmed_at >= asked_at)
           AND (approved_at  IS NULL OR approved_at  >= asked_at)
           AND (denied_at    IS NULL OR denied_at    >= asked_at)
           AND (withdrawn_at IS NULL OR withdrawn_at >= asked_at)),
  -- THE SILENCE (C52 (f)): a confirmation only once the wait has run, and
  -- only within the 30 days after it.
  ADD CONSTRAINT sealed_open_request_confirmed_after_wait
    CHECK (confirmed_at IS NULL
           OR (confirmed_at >= asked_at + make_interval(hours => wait_days * 24)
               AND confirmed_at < asked_at + make_interval(hours => (wait_days + 30) * 24))),
  -- THE OPENING: scheduled exactly when it was approved, or confirmed and
  -- neither denied nor withdrawn since; at the approval itself, or 48 hours
  -- after the confirmation; open 7 days.
  ADD CONSTRAINT sealed_open_request_open_pair
    CHECK ((opens_at IS NULL) = (open_until IS NULL)),
  ADD CONSTRAINT sealed_open_request_scheduled_iff
    CHECK ((opens_at IS NOT NULL)
           = (approved_at IS NOT NULL OR (confirmed_at IS NOT NULL AND denied_at IS NULL AND withdrawn_at IS NULL))),
  -- (Every disjunct NULL-safe: a CHECK passes on NULL.)
  ADD CONSTRAINT sealed_open_request_opens_when
    CHECK (opens_at IS NULL
           OR (approved_at IS NOT NULL AND opens_at = approved_at)
           OR (approved_at IS NULL AND confirmed_at IS NOT NULL AND opens_at = confirmed_at + interval '48 hours')),
  ADD CONSTRAINT sealed_open_request_open_seven_days
    CHECK (open_until IS NULL OR open_until = opens_at + interval '168 hours'),
  -- The mail bookkeeping: counted forward from the day-0 mail; the agency
  -- told it opened only once it has.
  ADD CONSTRAINT sealed_open_request_reminders
    CHECK (reminders_sent >= 0 AND (last_reminded_at IS NULL) = (reminders_sent = 0)),
  ADD CONSTRAINT sealed_open_request_opened_notice
    CHECK (opened_notice_at IS NULL OR (opens_at IS NOT NULL AND opened_notice_at >= opens_at));


-- ── The guard ───────────────────────────────────────────────────────
-- SECURITY INVOKER (the default): it reads the transaction's GUCs, other
-- asks of the same client, the contact's and member's own rows, the
-- member's roles and the client's door — each under the writer's own RLS,
-- which for SYSTEM and for a member of this tenant admits this tenant's
-- rows. Every refusal raises `SEALED_OPEN_REQUEST_GUARD`, never a value.
-- (Both FKs say ON UPDATE CASCADE, Prisma's default; a tenant's or a
-- client's id never changes, so the guard turning such a cascade into an
-- error costs nothing.)
CREATE OR REPLACE FUNCTION sealed_open_request_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
  at timestamptz := statement_timestamp();
  slack constant interval := interval '5 minutes';
  wall timestamptz;
  wait_end timestamptz;
  lapse_at timestamptz;
  pref jsonb;
  expected int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- THE ASK: the portal's vault broker, as SYSTEM.
    IF who IS DISTINCT FROM 'system' THEN
      RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: an ask is made through the portal''s vault broker';
    END IF;
    IF NEW.asked_at < at - slack OR NEW.asked_at > at
       OR NEW.created_at < at - slack OR NEW.created_at > at THEN
      RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: an ask is made now';
    END IF;
    -- Fresh: nothing answered, confirmed, withdrawn or scheduled; at most
    -- the day-0 mail recorded, stamped now.
    IF num_nonnulls(NEW.confirmed_at, NEW.confirmed_by_contact_id, NEW.approved_at, NEW.approved_by_member_id,
                    NEW.denied_at, NEW.denied_by_member_id, NEW.deny_reason,
                    NEW.withdrawn_at, NEW.withdrawn_by_contact_id,
                    NEW.opens_at, NEW.open_until, NEW.opened_notice_at) <> 0
       OR NEW.reminders_sent NOT IN (0, 1)
       OR (NEW.last_reminded_at IS NOT NULL AND (NEW.last_reminded_at < at - slack OR NEW.last_reminded_at > at)) THEN
      RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: a new ask has nothing but itself';
    END IF;
    -- Asked by an ACTIVE MAIN contact of this client (C61 (e)).
    IF NOT EXISTS (SELECT 1 FROM contact c
                    WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.asked_by_contact_id
                      AND c.client_id = NEW.client_id
                      AND c.portal_profile = 'CONTACT_PRIMARY' AND c.portal_status = 'ACTIVE'
                      AND c.invited_at IS NOT NULL) THEN
      RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: only an active main contact of the client asks';
    END IF;
    -- For something: the client has a sealed login (slice 92) to ask for.
    IF NOT EXISTS (SELECT 1 FROM credential_item ci
                    WHERE ci.tenant_id = NEW.tenant_id AND ci.client_id = NEW.client_id
                      AND ci.sealed_at IS NOT NULL AND ci.deleted_at IS NULL AND ci.archived_at IS NULL) THEN
      RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: nothing is sealed for this client';
    END IF;
    -- THE WAIT IS THE AGENCY'S (C52 (g)): exactly `vault.sealedWaitDays` as
    -- it stands — read as the application reads it (a whole number from 7
    -- to 60; anything else, or no row, is the default 7) — so no writer
    -- can shorten the wait an agency chose (the pre-apply review's medium).
    SELECT p.value INTO pref FROM tenant_preference p
     WHERE p.tenant_id = NEW.tenant_id AND p.key = 'vault.sealedWaitDays';
    expected := 7;
    IF pref IS NOT NULL AND jsonb_typeof(pref) = 'number' THEN
      IF (pref #>> '{}')::numeric = trunc((pref #>> '{}')::numeric)
         AND (pref #>> '{}')::numeric BETWEEN 7 AND 60 THEN
        expected := (pref #>> '{}')::numeric::int;
      END IF;
    END IF;
    IF NEW.wait_days IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: the wait is the agency''s own';
    END IF;
    -- ONE LIVE ASK PER CLIENT, and none within 30 days of a denial —
    -- under the client's lock, which the broker took first (re-entrant),
    -- so two asks racing are decided one after the other. Each statement
    -- below reads afresh (READ COMMITTED, a VOLATILE function), so the
    -- second sees the first once it has the lock.
    PERFORM pg_advisory_xact_lock(hashtext('sealed_open_request:' || NEW.tenant_id || ':' || NEW.client_id));
    IF EXISTS (SELECT 1 FROM sealed_open_request r
                WHERE r.tenant_id = NEW.tenant_id AND r.client_id = NEW.client_id AND r.id <> NEW.id
                  AND r.denied_at IS NULL AND r.withdrawn_at IS NULL
                  AND (   (r.open_until IS NOT NULL AND r.open_until > at)
                       OR (r.opens_at IS NULL
                           AND at < r.asked_at + make_interval(hours => (r.wait_days + 30) * 24)))) THEN
      RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: this client already has an ask that is waiting or open';
    END IF;
    IF EXISTS (SELECT 1 FROM sealed_open_request r
                WHERE r.tenant_id = NEW.tenant_id AND r.client_id = NEW.client_id AND r.id <> NEW.id
                  AND r.denied_at IS NOT NULL AND r.denied_at > at - interval '720 hours') THEN
      RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: a new ask waits 30 days after a denial';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE. What was asked, by whom, when, and for how long the wait
  -- runs never change.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.asked_by_contact_id IS DISTINCT FROM OLD.asked_by_contact_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.wait_days IS DISTINCT FROM OLD.wait_days
     OR NEW.asked_at IS DISTINCT FROM OLD.asked_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: what was asked cannot change';
  END IF;
  -- Every act is one-way: once made, never changed or taken back.
  IF (OLD.confirmed_at IS NOT NULL AND (NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
                                        OR NEW.confirmed_by_contact_id IS DISTINCT FROM OLD.confirmed_by_contact_id))
     OR (OLD.approved_at IS NOT NULL AND (NEW.approved_at IS DISTINCT FROM OLD.approved_at
                                          OR NEW.approved_by_member_id IS DISTINCT FROM OLD.approved_by_member_id))
     OR (OLD.denied_at IS NOT NULL AND (NEW.denied_at IS DISTINCT FROM OLD.denied_at
                                        OR NEW.denied_by_member_id IS DISTINCT FROM OLD.denied_by_member_id
                                        OR NEW.deny_reason IS DISTINCT FROM OLD.deny_reason))
     OR (OLD.withdrawn_at IS NOT NULL AND (NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
                                           OR NEW.withdrawn_by_contact_id IS DISTINCT FROM OLD.withdrawn_by_contact_id))
     OR (OLD.opened_notice_at IS NOT NULL AND NEW.opened_notice_at IS DISTINCT FROM OLD.opened_notice_at) THEN
    RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: an act on an ask is made once';
  END IF;

  wait_end := OLD.asked_at + make_interval(hours => OLD.wait_days * 24);
  lapse_at := OLD.asked_at + make_interval(hours => (OLD.wait_days + 30) * 24);

  -- AN ACT is decided under the client's ask lock — the one a new ask
  -- takes — and its deadlines are judged on the clock read AFTER every
  -- wait (the row's lock was taken before this trigger fired, the
  -- advisory lock just now), never `statement_timestamp()`, which a
  -- statement queued behind a look or an ask could hold from before the
  -- opening or the lapse it is no longer entitled to beat (the pre-apply
  -- review). Bookkeeping takes no advisory lock: it decides nothing.
  IF NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.denied_at IS DISTINCT FROM OLD.denied_at
     OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
    PERFORM pg_advisory_xact_lock(hashtext('sealed_open_request:' || OLD.tenant_id || ':' || OLD.client_id));
  END IF;
  wall := clock_timestamp();

  -- AN ANSWER, a confirmation or a withdrawal needs the ask still open to
  -- one: not ended, not opened yet (C61 (c): "until the moment it opens"),
  -- and not lapsed (an unconfirmed ask past its 30 days is over).
  IF (NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR NEW.denied_at IS DISTINCT FROM OLD.denied_at
      OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
      OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at)
     AND (OLD.approved_at IS NOT NULL OR OLD.denied_at IS NOT NULL OR OLD.withdrawn_at IS NOT NULL
          OR (OLD.opens_at IS NOT NULL AND OLD.opens_at <= wall)
          OR (OLD.confirmed_at IS NULL AND wall >= lapse_at)) THEN
    RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: this ask can no longer be answered, confirmed or withdrawn';
  END IF;

  IF who = 'member' THEN
    -- A member answers, as themselves, and does nothing else. Exactly one
    -- of the two answers, made now.
    IF NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
       OR NEW.reminders_sent IS DISTINCT FROM OLD.reminders_sent
       OR NEW.last_reminded_at IS DISTINCT FROM OLD.last_reminded_at THEN
      RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: a member only approves or denies';
    END IF;
    IF OLD.approved_at IS NULL AND NEW.approved_at IS NOT NULL THEN
      IF NEW.approved_by_member_id IS DISTINCT FROM who_id
         OR NEW.approved_at < at - slack OR NEW.approved_at > at
         OR NEW.denied_at IS NOT NULL
         -- The agency is told it opened by the approval itself.
         OR NEW.opened_notice_at IS DISTINCT FROM NEW.approved_at THEN
        RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: an approval is a member''s own, made now';
      END IF;
    ELSIF OLD.denied_at IS NULL AND NEW.denied_at IS NOT NULL THEN
      IF NEW.denied_by_member_id IS DISTINCT FROM who_id
         OR NEW.denied_at < at - slack OR NEW.denied_at > at
         OR NEW.opened_notice_at IS DISTINCT FROM OLD.opened_notice_at THEN
        RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: a denial is a member''s own, made now';
      END IF;
    ELSE
      RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: a member only approves or denies';
    END IF;
    -- …and only an ACTIVE member holding `credential:unseal` through a
    -- role, read as `effectivePermissions` reads it (a TENANT_REVOKE row
    -- grants nothing). C61 (f): the answer follows the roles.
    IF NOT EXISTS (SELECT 1
                     FROM member m
                     JOIN member_role mr ON mr.tenant_id = m.tenant_id AND mr.member_id = m.id
                     JOIN role_permission rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
                     JOIN permission p ON p.id = rp.permission_id
                    WHERE m.tenant_id = NEW.tenant_id AND m.id = who_id AND m.status = 'ACTIVE'
                      AND rp.source <> 'TENANT_REVOKE' AND p.code = 'credential:unseal') THEN
      RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: only a holder of credential:unseal answers';
    END IF;
    RETURN NEW;
  END IF;

  IF who IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: an ask is written by its broker, its job, or an answering member';
  END IF;

  -- SYSTEM never answers.
  IF NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by_member_id IS DISTINCT FROM OLD.approved_by_member_id
     OR NEW.denied_at IS DISTINCT FROM OLD.denied_at OR NEW.denied_by_member_id IS DISTINCT FROM OLD.denied_by_member_id
     OR NEW.deny_reason IS DISTINCT FROM OLD.deny_reason THEN
    RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: only a member approves or denies';
  END IF;

  -- THE CONFIRMATION (C52 (f)): after the wait, by an active main contact
  -- of the client whose door is OPEN right now — they gave their password
  -- and the code mailed to them a moment ago.
  IF OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL THEN
    IF at < wait_end
       OR NEW.confirmed_at < at - slack OR NEW.confirmed_at > at
       OR NEW.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: a confirmation comes after the wait, and now';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM contact c
                    WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.confirmed_by_contact_id
                      AND c.client_id = NEW.client_id
                      AND c.portal_profile = 'CONTACT_PRIMARY' AND c.portal_status = 'ACTIVE'
                      AND c.invited_at IS NOT NULL)
       OR NOT EXISTS (SELECT 1 FROM contact_vault_unlock u
                       WHERE u.tenant_id = NEW.tenant_id AND u.contact_id = NEW.confirmed_by_contact_id
                         AND u.open_until > wall AND u.opened_at >= wait_end) THEN
      RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: a confirmation is an active main contact''s, through their open door';
    END IF;
  END IF;

  -- A WITHDRAWAL: by an active main contact of the client; it clears the
  -- scheduled opening (the CHECK `sealed_open_request_scheduled_iff`).
  IF OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL THEN
    IF NEW.withdrawn_at < at - slack OR NEW.withdrawn_at > at
       OR NOT EXISTS (SELECT 1 FROM contact c
                       WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.withdrawn_by_contact_id
                         AND c.client_id = NEW.client_id
                         AND c.portal_profile = 'CONTACT_PRIMARY' AND c.portal_status = 'ACTIVE'
                      AND c.invited_at IS NOT NULL) THEN
      RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: a withdrawal is an active main contact''s, made now';
    END IF;
  END IF;

  -- THE MAIL BOOKKEEPING only goes forward, stamped now; the agency is
  -- told it opened once it has.
  IF NEW.reminders_sent < OLD.reminders_sent
     OR (NEW.last_reminded_at IS DISTINCT FROM OLD.last_reminded_at
         AND (NEW.last_reminded_at IS NULL OR NEW.last_reminded_at < at - slack OR NEW.last_reminded_at > at
              OR (OLD.last_reminded_at IS NOT NULL AND NEW.last_reminded_at < OLD.last_reminded_at))) THEN
    RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: the reminders only go forward, stamped now';
  END IF;
  IF OLD.opened_notice_at IS NULL AND NEW.opened_notice_at IS NOT NULL
     AND (NEW.opens_at IS NULL OR NEW.opens_at > at
          OR NEW.opened_notice_at < at - slack OR NEW.opened_notice_at > at) THEN
    RAISE EXCEPTION 'SEALED_OPEN_REQUEST_GUARD: the agency is told it opened once it has, and now';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sealed_open_request_guard
  BEFORE INSERT OR UPDATE ON sealed_open_request
  FOR EACH ROW EXECUTE FUNCTION sealed_open_request_guard();


-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, UPDATE ON sealed_open_request TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class A (portal_deny) ─────────────────────────────────────
ALTER TABLE sealed_open_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE sealed_open_request FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sealed_open_request
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON sealed_open_request
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');
