-- ═══════════════════════════════════════════════════════════════════
-- Phase 3V slice 92 — THE SEALED LAYER, STAFF SIDE (founder decisions
-- C52 (e), C60). A login an agency keeps FOR a client and does not want
-- opened without real need is SEALED: staff use it as before ("staff
-- never ask" — C52 (e)); the client is kept out, and (slice 93) may ask to
-- open their sealed logins, every owner told, and wait. Anyone who can
-- edit a login seals it; only an owner unseals one or deletes a sealed one
-- (C52 (e), C60 (b)) — permission checks, which live in the service
-- (`src/modules/vault/seal.ts`, `items.ts`); the database holds what a
-- seal IS. DATA_MODEL.md §6.17; AUTHZ.md §3.2.1 (`credential:unseal`).
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed. A nullable
-- column, three CHECKs that every existing row satisfies (no row is
-- sealed yet), and one trigger. No grant changes: `credential_item` and
-- `credential_share_link` keep theirs (grants are per table, so the new
-- column inherits them).
--
-- 1. `credential_item.sealed_at` — when it was sealed; NULL = not sealed.
--    Who sealed it is the audit trail's (`credential.sealed`, actor the
--    member), not a column: nothing reads it back.
--
-- 2. WHAT A SEAL IS, as CHECKs (each refuses a state no code path may
--    reach, whatever a later service does):
--    - `credential_item_sealed_needs_client` — a seal is kept FOR a
--      client; the agency's own logins (C49, `client_id` NULL) have
--      nobody who could ever ask.
--    - `credential_item_sealed_is_internal` — sealed means the client gets
--      it only by asking (C60 (a)), so a sealed login is never shown to
--      the client (`CLIENT_VISIBLE`, slice 91). Sealing a shown login
--      hides it in the same write; showing a sealed one is refused. A
--      consequence worth naming: slice 91's whole client path — the
--      contact's own read through `portal_gate` and `portal_vault_switch`,
--      and the broker's restated CLIENT_VISIBLE — refuses a sealed login
--      with no change of its own; and slice 93's "open for seven days"
--      (C52 (h)) cannot be a contact-principal read through `portal_gate`
--      (which needs CLIENT_VISIBLE): it is a brokered SYSTEM read, or this
--      CHECK is dropped by name.
--    - `credential_item_sealed_is_live` — a binned login is not sealed:
--      deleting a sealed login (owners only, C60 (b)) clears the seal in
--      the same write. So a future restore (none exists yet) brings a
--      once-sealed login back UNSEALED — shareable and showable by
--      non-owners — unless it re-seals it: whoever builds restore decides.
--
-- 3. `credential_share_link_not_sealed` — a BEFORE INSERT trigger on
--    `credential_share_link`: no link is made to a sealed login (C60 (a)),
--    for ANY writer. It takes the login's row `FOR SHARE` and refuses
--    unless it finds the row unsealed (fail closed: a row the inserter
--    cannot see is refused too). `FOR SHARE` conflicts with the seal's
--    row lock (its UPDATE), so either the seal waits for the link to
--    commit — and a later statement in it, on a fresh READ COMMITTED
--    snapshot, revokes it — or this trigger waits for the seal and
--    re-reads the row it wrote, finds it sealed, and refuses.
--    `createShareLink` already holds the same lock (and refuses a sealed
--    login itself), so for the product's one writer this adds no wait and
--    no new lock order; the seal takes the login's row before any link's,
--    always. `app_runtime` holds UPDATE on `credential_item`, which
--    `FOR SHARE` needs; the link's own `tenant_isolation` pins
--    `NEW.tenant_id` to the member's tenant, and on `credential_item` only
--    a contact is denied there. INSERT ONLY, DELIBERATELY: the share page
--    holds a link's row before it reads the login, and a seal holds the
--    login before it revokes links — a `FOR SHARE` on the UPDATE path
--    would deadlock against a seal; the open is refused in code
--    (`share-open.ts`). Its own
--    trigger, not a change to `credential_share_link_guard`
--    (20261004120000): the guard is unchanged, byte for byte. Triggers on
--    one event fire in name order, so the guard (who, when, fresh) runs
--    first, and only a member, as themselves, ever reaches this one.
--    search_path pinned (the function reads a table by name).
--    It does NOT end links that already exist: sealing revokes them
--    (`credential.share_revoked`, cause `sealed`), and the share page
--    refuses a sealed login's link besides (`share-open.ts`).
-- ═══════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "credential_item" ADD COLUMN     "sealed_at" TIMESTAMPTZ(6);

ALTER TABLE credential_item
  ADD CONSTRAINT credential_item_sealed_needs_client
    CHECK (sealed_at IS NULL OR client_id IS NOT NULL),
  ADD CONSTRAINT credential_item_sealed_is_internal
    CHECK (sealed_at IS NULL OR visibility = 'INTERNAL'),
  ADD CONSTRAINT credential_item_sealed_is_live
    CHECK (sealed_at IS NULL OR deleted_at IS NULL);


CREATE OR REPLACE FUNCTION credential_share_link_not_sealed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  PERFORM 1 FROM credential_item c
   WHERE c.tenant_id = NEW.tenant_id
     AND c.id = NEW.credential_id
     AND c.sealed_at IS NULL
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRED_SHARE_LINK_SEALED: a share link is made only to a login that is not sealed';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER credential_share_link_not_sealed
  BEFORE INSERT ON credential_share_link
  FOR EACH ROW EXECUTE FUNCTION credential_share_link_not_sealed();
