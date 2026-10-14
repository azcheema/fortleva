-- ═══════════════════════════════════════════════════════════════════
-- Phase 6 slice 118 — THE SQL ORIGIN REFUSES WHAT THE APP REFUSES (the
-- re-check of the slice's review fixes, its 1; before any row existed
-- outside throwaway tenants).
--
-- `website_speed_origin_of` (20261023110000) cut the authority at the first
-- `/`, `?`, `#`, `@` or whitespace — so for `https://example.com@evil.com`
-- or `https://example.com /x` it answered `https://example.com`, while the
-- app's `originOf` (`new URL`, refusing a credential; `src/modules/reports/
-- speed-shapes.ts`) answers null for both. One such edit of a Production
-- URL would have left the site's rows CLIENT_VISIBLE (the fan-out's
-- comparison still matched) with the nav's count saying 1 and the page
-- saying nothing. Now an authority holding `@` or whitespace is no origin
-- at all: NULL, so every row of the project is INTERNAL and the count is 0
-- — the app's answer.
--
-- Forward, as every correction is. DDL only, no DML.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION website_speed_origin_of(p_url text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE
           WHEN p_url IS NULL THEN NULL
           -- A credential, or whitespace, before the path: not an origin.
           WHEN p_url ~ '^[hH][tT][tT][pP][sS]?://[^/?#]*[@\s]' THEN NULL
           WHEN o IS NULL THEN NULL
           WHEN o ~ '^https://[^:]+:443$' THEN left(o, -4)
           WHEN o ~ '^http://[^:]+:80$' THEN left(o, -3)
           ELSE o
         END
    FROM (SELECT lower(substring(p_url from '^[hH][tT][tT][pP][sS]?://[^/?#@\s]+')) AS o) AS u
$fn$;
