-- ── The triage lane's one schema need: the agency's words to the
--    client, on the row the client submitted ─────────────────────────
--
-- Phase 3 slice 6b. `20260921180000` gave the portal REQUEST intake its
-- index; this gives the member-side answer somewhere to live.
--
-- WHY A COLUMN AND NOT A COMMENT. DATA_MODEL §6.14 pins triage
-- `DECLINED` and `DUPLICATE` to a CANCELLED-category state, and
-- `modules/work/portal.ts` maps CANCELLED to NOTHING — so the one row on
-- a client's list that they submitted themselves disappeared silently
-- the moment the agency said no. That file's own header calls it
-- "indefensible", and the founder decided it on 2026-09-22: a declined
-- request is SHOWN, with the reason. A `Comment` would have carried the
-- text too, but the portal's task list is one projection over
-- `work_item` and a per-row comment join is a second read on the
-- least-trusted surface in the product; a column on the row the
-- projection already reads costs nothing and cannot come back holding
-- somebody else's thread.
--
-- IT IS THE ONLY FREE TEXT IN THIS MODEL WRITTEN BY A MEMBER AND READ BY
-- A CONTACT, which is worth saying in the schema and not only in the
-- service: `title` and `description_text` on a REQUEST are the CLIENT'S
-- own words coming back to them, and everything else the portal projects
-- is a date, a category or a name the agency already publishes. Capped
-- at 500 characters in the type rather than only in a parser, because
-- the parser is one caller and the column is forever.
ALTER TABLE "work_item" ADD COLUMN "triage_reason" VARCHAR(500);

-- ── Two CHECKs, because "the client is told why" is an invariant and
--    not a convention ────────────────────────────────────────────────
--
-- 1. THE REASON AND THE OUTCOME IMPLY EACH OTHER. A biconditional, both
--    halves of which are load-bearing:
--
--      → a `DECLINED` or `DUPLICATE` row MUST carry a reason. This is
--        the founder's decision as a database fact: no path — not the
--        triage service, not a future import, not a hand-written
--        UPDATE — can make a client's own request vanish without
--        telling them why.
--      ← a reason may exist ONLY on such a row, so `transitionState`'s
--        clear-on-leaving-triage cannot leave a stale explanation
--        attached to work that is going ahead after all.
--
--    Written with an explicit `IS NOT NULL AND … IN (…)` on the left so
--    the comparison is between two proper booleans: `triage_status` is
--    nullable, and a bare `triage_status IN (…)` would be NULL rather
--    than FALSE for the overwhelming majority of rows, which a CHECK
--    reads as "satisfied" and which would have made the left-to-right
--    half of this constraint silently inert. The blank clause is the
--    same rule the service applies to a trimmed string: an empty reason
--    is an absent one wearing a value.
--
-- 2. A DUPLICATE NAMES WHAT IT DUPLICATES. §6.14's own wording
--    ("DUPLICATE // → CANCELLED-category state; duplicateOfId set"),
--    which had no enforcement. `IS DISTINCT FROM` rather than `<>` for
--    the NULL reason above.
--
-- NOT VALID + VALIDATE, the pattern 20260912120000 records, and the
-- audit that makes the scan safe is short: NOTHING in this product has
-- ever written `triage_status` to anything but 'PENDING'
-- (`src/modules/work/requests.ts` is its only writer, at intake), and
-- `duplicate_of_id` and `triage_reason` have no writer at all — the
-- latter is created NULL two statements above. CI migrates from an
-- EMPTY database and so cannot see a violating row; this is what was
-- checked instead. DDL only, no DML: no `neon-smoke` dispatch is owed.
ALTER TABLE "work_item"
  ADD CONSTRAINT work_item_triage_reason_iff_outcome CHECK (
    (
      (triage_status IS NOT NULL AND triage_status IN ('DECLINED', 'DUPLICATE'))
        = (triage_reason IS NOT NULL)
    )
    AND (triage_reason IS NULL OR btrim(triage_reason) <> '')
  ) NOT VALID;
ALTER TABLE "work_item" VALIDATE CONSTRAINT work_item_triage_reason_iff_outcome;

ALTER TABLE "work_item"
  ADD CONSTRAINT work_item_triage_duplicate_has_target CHECK (
    triage_status IS DISTINCT FROM 'DUPLICATE' OR duplicate_of_id IS NOT NULL
  ) NOT VALID;
ALTER TABLE "work_item" VALIDATE CONSTRAINT work_item_triage_duplicate_has_target;

-- ── What this migration deliberately does NOT touch ─────────────────
--
-- NO RLS CHANGE, and it was checked rather than assumed. `work_item`'s
-- `portal_gate` (20260820170000) is
--
--   client_id = app.client_id AND visibility = 'CLIENT_VISIBLE'
--   AND portal_enabled
--
-- with no `state_category` term and no `reported_by_contact_id` term.
-- Both matter for this slice:
--
--   · No category term means a CANCELLED client-visible row is ALREADY
--     readable by a contact — the row was hidden by the projection's
--     `where`, never by the database. Showing a declined request is
--     therefore a projection change and needs no new policy, which is
--     the cheap direction to have been in.
--   · No reporter term means every contact of a client reads every
--     request that client submitted. That is now a DECISION rather than
--     an accident (founder, 2026-09-22): a Client is a company, the
--     agency's counterparty is the company, and a request that only its
--     submitter can see is orphaned the day they leave. Recorded here
--     because this is the file a future reader greps when they ask why
--     the gate has no per-contact term.
--
-- NO GRANT, either: `work_item`'s is table-level (20260820170000), so
-- the new column is covered by the existing SELECT/INSERT/UPDATE/DELETE.
