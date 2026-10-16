-- ═══════════════════════════════════════════════════════════════════
-- Slice 125 — @MENTIONS IN COMMENTS (founder decision C101;
-- docs/research/2026-10-16-slice-125-mentions-design.md §3.6).
--
-- A member can now type @name in a comment to tell a teammate. Only
-- teammates can be mentioned (C101 (a)), and only in an INTERNAL note
-- (C101 (b)): a client never sees a member's name, so a body that
-- mentions someone can never be one a client reads. The comment's
-- `mention` node stores a member id and nothing else; the name is
-- resolved when a member reads it.
--
--   `mention` has existed since 20260820170000 with its grants and its
--   class-A policies (`tenant_isolation` + `portal_deny`), and nothing has
--   ever written it. Its first writer arrives with two belts the original
--   table lacked:
--     · `mention_member_only` — a row names exactly one MEMBER and no
--       contact: C101 (a), held by the database. The day a client's people
--       can be mentioned, this CHECK is loosened with that decision;
--     · `mention_member_once` — one row per comment and member. The
--       schema's four-column UNIQUE never deduplicated: one column is
--       always NULL and NULLs are distinct.
--
--   `comment_visible_no_mention` — a CHECK on `comment`: a CLIENT_VISIBLE
--   row's body holds no `mention` node. A CHECK, not a trigger (the
--   pre-apply review's LOW): it is evaluated after every BEFORE trigger on
--   every write, whatever columns it touches, so no trigger added later can
--   change a row's visibility or body behind it. The services refuse first,
--   with a sentence (COMMENT_MENTION_VISIBLE on a post or an edit,
--   COMMENT_HAS_MENTION on a raise); this is the belt for every writer,
--   including one not written yet and a contact's insert under
--   `portal_gate` (a contact's comment is built from plain text on the
--   server and can hold no mention anyway). The mapper matches it by the
--   constraint's NAME, which is not spelled like any service code: outside
--   production Prisma prints the caller's source lines into an error's
--   message, and a token spelled like a `fail(...)` beside a query would
--   match any error that query raised.
--
--   `notification_reason_known` WIDENED by one reason, `MENTIONED` —
--   "someone mentioned you" — FIRST in the list: it is the most specific
--   reason there is, and `src/notify/reasons.ts` keeps the order as the
--   precedence.
--
-- CONTACT WRITES: none new. `mention` stays `portal_deny`; the CHECK only
-- refuses.
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. The file runs as
-- one transaction, so a CHECK that fails to validate rolls everything back
-- anyway; the guard is there to say WHICH rule an existing row breaks, in a
-- sentence. Nothing here is modelled by Prisma (CHECKs and a UNIQUE index
-- on columns it already knows), so `schema.prisma` is unchanged.
-- ═══════════════════════════════════════════════════════════════════

-- ── The table locks, FIRST ──────────────────────────────────────────
-- Taken at once with a bounded wait (the imports migration's lesson,
-- 20261026090000), never upgraded from the guard's reads; in the order the
-- app writes them — the comment, its mentions, then the notifications.
-- ACCESS EXCLUSIVE on `comment` is what ADD CONSTRAINT … CHECK takes while
-- it validates the existing rows.
SET LOCAL lock_timeout = '10s';
LOCK TABLE comment IN ACCESS EXCLUSIVE MODE;
LOCK TABLE mention IN ACCESS EXCLUSIVE MODE;
LOCK TABLE notification IN ACCESS EXCLUSIVE MODE;

-- ── Guards ──────────────────────────────────────────────────────────
-- `row_security = off` IS LOAD-BEARING (20260906150000's reasoning): the
-- tables are FORCE ROW LEVEL SECURITY with policies `TO app_runtime`, so a
-- migrating role without BYPASSRLS would see NO rows and every guard would
-- pass having looked at nothing. Off, such a role FAILS the read.
SET LOCAL row_security = off;
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mention
    WHERE mentioned_member_id IS NULL OR mentioned_contact_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'slice 125: a mention row names no member, or a contact; fix it before this migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mention
    GROUP BY tenant_id, comment_id, mentioned_member_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'slice 125: a comment mentions one member twice; fix it before this migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM comment
    WHERE visibility = 'CLIENT_VISIBLE'
      AND jsonb_path_exists(body, '$.** ? (@.type == "mention")')
  ) THEN
    RAISE EXCEPTION 'slice 125: a client-visible comment holds a mention; fix it before this migration';
  END IF;
END
$guard$;

-- ── mention ─────────────────────────────────────────────────────────

ALTER TABLE mention
  ADD CONSTRAINT mention_member_only
  CHECK (mentioned_member_id IS NOT NULL AND mentioned_contact_id IS NULL);

-- What the service's `createMany … skipDuplicates` and its edit's diff rely
-- on. With the member column NOT NULL by the CHECK above, a plain UNIQUE
-- deduplicates.
CREATE UNIQUE INDEX mention_member_once
  ON mention (tenant_id, comment_id, mentioned_member_id);

-- ── comment: no mention in a body a client reads ────────────────────
-- `$.** ? (@.type == "mention")` — any object at any depth whose `type` KEY
-- is "mention" (the contract guard's `@.type == "text"` test, 20261016090000,
-- reads the key the same way). Lax mode: a string, a number or null has no
-- `type` and simply does not match, and nothing raises. A mark is
-- `{type: "bold"}` and the schema has no mark of that name; an ordered
-- list's `attrs.type` is one of a/A/i/I/1 (normalize.ts) — so only the node
-- matches. `jsonb_path_exists` without a timezone is IMMUTABLE, as a CHECK
-- requires. The walk is bounded for every service writer by the comment's
-- 128 KB cap (`COMMENT_JSON_BYTES`); the database itself caps nothing. An
-- INTERNAL row short-circuits on the first term and is never walked.
ALTER TABLE comment
  ADD CONSTRAINT comment_visible_no_mention
  CHECK (visibility <> 'CLIENT_VISIBLE' OR NOT jsonb_path_exists(body, '$.** ? (@.type == "mention")'));

-- ── The reason set, widened ─────────────────────────────────────────
-- One statement: the swap is atomic whether or not the runner wraps the
-- file. `MENTIONED` sits FIRST — the order `src/notify/reasons.ts` keeps
-- (the precedence).
ALTER TABLE notification
  DROP CONSTRAINT notification_reason_known,
  ADD CONSTRAINT notification_reason_known CHECK (
    reason IS NULL OR (receiver_type = 'MEMBER' AND reason IN (
      'MENTIONED',
      'ASSIGNEE',
      'REQUESTER',
      'PROJECT_LEAD',
      'PROJECT_MEMBER',
      'CLIENT_MEMBER',
      'BUDGET_WATCHER',
      'VAULT_ACCESS',
      'INVOICE_ACCESS',
      'REPORT_ACCESS',
      'OWNER'
    ))
  );
