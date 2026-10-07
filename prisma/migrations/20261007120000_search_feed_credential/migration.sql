-- ═══════════════════════════════════════════════════════════════════
-- Phase 3V slice 97 — THE SEARCH FEED FOR LOGINS: a login's name,
-- username, web address and tags reach `search_index`, so search and ⌘K
-- can find it (founder decision C65, 2026-10-07; DATA_MODEL.md §6.19's
-- `CREDENTIAL_ITEM` row, §6.17's "Search:" line). WHO may find one, and
-- WHEN, is the reader's business (`src/search/query.ts` with
-- `src/modules/vault/search.ts`): only through the vault's door (C52 (a))
-- and the vault's own reach rule (C49). This migration only decides what
-- the index HOLDS.
--
-- DML: one backfill INSERT of the existing logins (section 4). The script
-- that applies it to the dev database (Smart App Control blocks Prisma's
-- schema engine on the founder's machine — C65 (b)) runs it against that
-- database's real rows, which is the real-data run `neon-smoke.yml` exists
-- to give a migration with DML; CI then applies it from EMPTY with Prisma
-- itself. No grant changes: `search_index` and `credential_item` keep
-- theirs, and a new function is executable by PUBLIC (the house default,
-- as `search_upsert` is).
--
-- Reviewed by a fresh agent before it was applied. Its one medium is
-- taken: the parent-domain expansion was unbounded — a client can hand a
-- login over through the portal (slice 96) with a 2 KB address of
-- one-letter labels, and every suffix of it would have been a lexeme,
-- about 1 MB of index text from one login, past `tsvector`'s cap — so the
-- feed would have THROWN and aborted the write that fed it (the backfill
-- and a locale restamp too). Now bounded (section 1). Its lows are taken
-- as well: the trigger no longer fires on `updated_at` (section 3), and
-- what this header said about `portal_enabled` and failing closed is
-- corrected below. A second, narrow round over those fixes found nothing
-- that throws; its low (the tags' LENGTH is unbounded in the database)
-- and its nits (the size arithmetic, a long email domain, the reset-link
-- wording) are taken in section 1.
--
-- 1. `search_credential_meta(username, url, tags)` — the B-weight text
--    of a login's index row. NEVER the notes and NEVER a secret: the
--    notes are free text a member may have pasted anything into (DATA_
--    MODEL §6.17: "never notes containing anything secret-shaped"), and
--    the secret lives in another table this feed never reads. The
--    address loses its QUERY STRING and FRAGMENT first, everywhere it is
--    used: a token there (`?key=…`, `#…`) is not something to search by,
--    nor to copy into a second table. (A token in the PATH — `/reset/<t>`
--    — stays: it is part of the address, under the same door.) Measured on the dev database before
--    writing (both configs alike): the default parser keeps a web address
--    and an email WHOLE — `https://www.acme.se/wp-admin/` is the lexemes
--    `www.acme.se`, `www.acme.se/wp-admin/` and `/wp-admin/`;
--    `anna@acme.se` is one — so searching "acme.se", "acme" or "anna"
--    would find nothing. The function therefore adds, beside the
--    username, the address and the tags as written:
--      - the address's HOST itself and at most its last three parent
--        domains, each of two labels or more (`www.acme.se acme.se`) —
--        and the same for the domain of a username that is an email, so
--        "acme.se" matches, and so does a long email domain whole (the
--        parser keeps only the whole address as a word). A host longer
--        than a DNS name may be (253) is not expanded at all;
--      - the tags, CLIPPED to 1100 characters here: the database bounds
--        their NUMBER (20) but not their length, and the service's
--        20 × 50 is 1019 — a writer that skipped `normalizeTags` must not
--        be able to grow this text (the narrow review's low).
--    So the whole text is at most about 7.3 K characters (username 320
--    and address 2048 by the database's own CHECKs, the tags by the clip,
--    the hosts by the 253 and the four-suffix limit) — at most ~29 KB even
--    in four-byte characters, well over an order of magnitude inside
--    `tsvector`'s 1 MB cap, whoever writes the row. Also:
--      - the username and the address (without its scheme, or "https"
--        would match every login with an address) cut into words at
--        punctuation — so "acme", "anna", "björn" match (unaccent and
--        the stemmer then treat them as every other word).
--    STABLE (`concat_ws` and `array_to_string` are), and pure: the trigger
--    and the backfill below compute the same text from the same columns.
--    Nothing is case-folded but the hosts, which are case-insensitive by
--    definition (the configs fold words themselves); a trailing dot is
--    dropped from a host.
--
-- 2. `search_feed_credential_item()` — the feed. A binned login
--    (`deleted_at`) or a deleted one leaves the index, as the work-item,
--    comment and document feeds do; anything else is upserted with:
--      - `visibility` 'INTERNAL' ALWAYS, even for a login shown to the
--        client (`credential_item.visibility = 'CLIENT_VISIBLE'`, slice
--        91). The portal has no search, and `search_index`'s
--        `portal_gate` must never be the thing standing between a
--        contact and a login's name: a CLIENT_VISIBLE index row would
--        satisfy the two-term gate in full, while `credential_item`
--        itself holds a contact to much more (`portal_vault_switch`: the
--        switch on, a main contact, a live login). INTERNAL keeps every
--        contact at zero rows here, whatever else the row says.
--      - `portal_enabled` false from THIS feed. It is not the safety (the
--        INTERNAL is): the portal switch's fan-out and reconcile
--        (20260928180000) re-derive `portal_enabled` on EVERY index row of
--        a project, a project's logins included, so under a switched-on
--        project the row reads true until this feed next writes it, and
--        the next switch's reconcile counts it as corrected. Never an
--        alarm — under a switched-off project both write false.
--      - `subtitle` NULL. The result row's second line is the login's
--        PLACE — the project's key or the client's name — which the
--        reader resolves from the live rows, as it does every address:
--        a client's rename fires no credential feed, so a name baked in
--        here would go stale.
--    NO early return under a contact principal (the document feed has
--    one): a contact cannot write `credential_item` at all
--    (`portal_no_insert` / `_update` / `_delete`), so this trigger never
--    fires as one. If a future policy ever let a contact insert or edit a
--    login, the feed's upsert would be refused by `search_index`
--    (`portal_comment_rows_only`), failing the contact's write CLOSED —
--    an early return would have hidden that. (A contact's DELETE branch
--    would be filtered silently by `portal_no_delete` instead, leaving a
--    stale row for the reader's hydrate to drop.)
--
-- 3. The trigger: every INSERT and DELETE, and an UPDATE of a column the
--    row is built from, plus `deleted_at` (the bin, both ways). NOT
--    `updated_at`: Prisma stamps it on every write, and the writes that
--    touch nothing indexed — a "Change soon" flag on a member's removal
--    (`flagLoginsKnownBy`), "Hide every shown login" (`hideEveryShownLogin`),
--    a seal, a show, a new secret — would each have re-fed the row, and
--    the multi-row ones would have locked index rows in their own order,
--    a deadlock partner for the switch's fan-out and the locale restamp
--    (the review). Search recency (`search_index.updated_at`, the
--    ranking's tiebreaker) therefore moves when something a login is
--    FOUND BY changes, which is what it is for. A reveal, a copy or a
--    share writes no `credential_item` row at all.
--
-- 4. The backfill: every live (unbinned) login, with its own
--    `updated_at` as the index row's recency rather than the moment this
--    migration ran — every existing login would otherwise tie as "just
--    changed". `ON CONFLICT DO NOTHING` because nothing can have fed a
--    login before this trigger existed. `row_security = off` for the
--    reason `20260906150000_search_feed_soft_delete` gives: both tables
--    are FORCE ROW LEVEL SECURITY with policies `TO app_runtime`, so a
--    migration role without BYPASSRLS would read no login and insert
--    none, and succeed; with row security off it fails instead.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. What a login's row is found by ───────────────────────────────
CREATE OR REPLACE FUNCTION search_credential_meta(p_username text, p_url text, p_tags text[])
RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  WITH u AS (
    -- The address without its query string or fragment.
    SELECT regexp_replace(p_url, '[?#].*$', '') AS url
  ), h AS (
    SELECT rtrim(lower(substring(u.url FROM '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#:]+)')), '.') AS url_host,
           rtrim(lower(substring(p_username FROM '@([^@[:space:]]+)$')), '.') AS mail_host
      FROM u
  )
  SELECT concat_ws(' ',
    p_username,
    (SELECT url FROM u),
    -- Clipped: the database bounds how many tags, not how long.
    nullif(left(array_to_string(p_tags, ' '), 1100), ''),
    -- Each host itself, and at most its last three parent domains, each
    -- of two labels or more; a host past a DNS name's 253 is not expanded.
    (SELECT string_agg(array_to_string(p.parts[i:], '.'), ' ')
       FROM h,
            LATERAL (SELECT string_to_array(x, '.') AS parts
                       FROM unnest(ARRAY[h.url_host, h.mail_host]) AS x
                      WHERE x IS NOT NULL AND char_length(x) <= 253) p,
            LATERAL generate_subscripts(p.parts, 1) AS i
      WHERE i < array_length(p.parts, 1)
        AND (i = 1 OR i >= array_length(p.parts, 1) - 3)),
    -- The username and the address, scheme dropped, as plain words.
    nullif(btrim(regexp_replace(
      coalesce(p_username, '') || ' ' ||
        coalesce(regexp_replace((SELECT url FROM u), '^[A-Za-z][A-Za-z0-9+.-]*://', ''), ''),
      '[[:punct:][:space:]]+', ' ', 'g')), ''))
$fn$;

-- ── 2. The feed ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION search_feed_credential_item() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.deleted_at IS NOT NULL THEN
    DELETE FROM search_index
     WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
       AND entity_type = 'CREDENTIAL_ITEM'
       AND entity_id = COALESCE(NEW.id, OLD.id);
    RETURN NULL;
  END IF;
  PERFORM search_upsert(
    NEW.tenant_id, 'CREDENTIAL_ITEM', NEW.id, NEW.client_id, NEW.project_id,
    'INTERNAL', false, NEW.name,
    NULL, NULL, search_credential_meta(NEW.username, NEW.url, NEW.tags), NULL, NULL);
  RETURN NULL;
END
$fn$;

-- ── 3. The trigger ───────────────────────────────────────────────────
CREATE TRIGGER search_feed_credential_item
  AFTER INSERT OR DELETE OR UPDATE OF name, username, url, tags, client_id, project_id, deleted_at
  ON credential_item
  FOR EACH ROW EXECUTE FUNCTION search_feed_credential_item();

-- ── 4. DML: the logins that predate the feed ─────────────────────────
SET LOCAL row_security = off;

INSERT INTO search_index (tenant_id, entity_type, entity_id, client_id, project_id,
                          visibility, portal_enabled, title, subtitle, body_text, meta_text,
                          lang, updated_at)
SELECT ci.tenant_id, 'CREDENTIAL_ITEM', ci.id, ci.client_id, ci.project_id,
       'INTERNAL', false, ci.name, NULL, NULL, search_credential_meta(ci.username, ci.url, ci.tags),
       search_lang(ci.tenant_id), ci.updated_at
  FROM credential_item ci
 WHERE ci.deleted_at IS NULL
ON CONFLICT (tenant_id, entity_type, entity_id) DO NOTHING;
