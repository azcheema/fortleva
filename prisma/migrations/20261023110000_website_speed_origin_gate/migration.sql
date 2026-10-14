-- ═══════════════════════════════════════════════════════════════════
-- Phase 6 slice 118 — THE GATE KNOWS THE SITE (the slice's security
-- review, its 1; before any row existed outside throwaway tenants).
--
-- 20261023090000 derived `website_speed_week.visibility` from the project's
-- "Show to the client" switch alone. A project whose Production URL moves
-- keeps the old site's rows as history (20261023100000), and only the
-- projection's `where` kept those from a contact: CLIENT_VISIBLE +
-- portal_enabled rows of a site the project no longer names, readable
-- under the contact principal by any read that is not the projection —
-- against the rule that the gate decides, never a projection. Harmless in
-- substance (Google's data for a site is public to any key holder), wrong
-- in shape.
--
-- Now the stamp and the fan-out derive `visibility` from BOTH the switch
-- and whether the row's `origin` is the origin of the project's CURRENT
-- Production URL — the fan-out firing on a change of either column — so a
-- URL move makes the old site's rows INTERNAL in the same transaction, and
-- a row of another site is born INTERNAL whatever the switch says.
--
-- THE ORIGIN IN SQL (`website_speed_origin_of`): the scheme and host (and
-- port) of an http(s) URL, lower-cased, a default port dropped — what
-- `originOf` (`src/modules/reports/speed-shapes.ts`, `new URL().origin`)
-- answers for an ASCII host. An IDN host, which `new URL` re-spells as
-- punycode, matches nothing here: such a site's rows stay INTERNAL (the
-- team still sees them; the client never does — fail closed, recorded in
-- DATA_MODEL §6.10). NULL for anything that is not an http(s) URL.
--
-- Forward, as every correction is. DDL only, no DML — no `neon-smoke.yml`
-- dispatch owed. The trigger NAMES are unchanged (`isolation.dbtest.ts`
-- pins `project`'s exact set); the fan-out stays AFTER and never writes
-- `portal_enabled`.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION website_speed_origin_of(p_url text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE
           WHEN o IS NULL THEN NULL
           WHEN o ~ '^https://[^:]+:443$' THEN left(o, -4)
           WHEN o ~ '^http://[^:]+:80$' THEN left(o, -3)
           ELSE o
         END
    FROM (SELECT lower(substring(p_url from '^[hH][tT][tT][pP][sS]?://[^/?#@\s]+')) AS o) AS u
$fn$;

CREATE OR REPLACE FUNCTION website_speed_week_stamp_visibility() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  shown boolean;
  site  text;
BEGIN
  SELECT p.portal_show_speed, website_speed_origin_of(p.production_url) INTO shown, site
    FROM project p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'website_speed_week: project not found in tenant';
  END IF;
  NEW.visibility := CASE WHEN shown AND site IS NOT NULL AND NEW.origin = site
                         THEN 'CLIENT_VISIBLE'::"Visibility" ELSE 'INTERNAL'::"Visibility" END;
  RETURN NEW;
END
$fn$;
-- The stamp now reads `origin` too: a direct write of the origin re-derives.
DROP TRIGGER IF EXISTS website_speed_week_stamp_visibility ON website_speed_week;
CREATE TRIGGER website_speed_week_stamp_visibility
  BEFORE INSERT OR UPDATE OF project_id, visibility, origin ON website_speed_week
  FOR EACH ROW EXECUTE FUNCTION website_speed_week_stamp_visibility();

CREATE OR REPLACE FUNCTION project_speed_sharing_fanout() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
  IF NEW.portal_show_speed IS DISTINCT FROM OLD.portal_show_speed
     OR NEW.production_url IS DISTINCT FROM OLD.production_url THEN
    UPDATE website_speed_week
       SET visibility = CASE WHEN NEW.portal_show_speed
                              AND origin = website_speed_origin_of(NEW.production_url)
                             THEN 'CLIENT_VISIBLE'::"Visibility" ELSE 'INTERNAL'::"Visibility" END
     WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
  END IF;
  RETURN NULL;
END
$fn$;
DROP TRIGGER IF EXISTS project_speed_sharing_fanout ON project;
CREATE TRIGGER project_speed_sharing_fanout
  AFTER UPDATE OF portal_show_speed, production_url ON project
  FOR EACH ROW EXECUTE FUNCTION project_speed_sharing_fanout();
