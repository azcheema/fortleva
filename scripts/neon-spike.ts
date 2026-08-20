// Neon spike (PLAN.md §0 item 2 / Phase 1b leftover): verify, against
// the REAL database, the five mechanisms the 2W/2T migrations depend
// on, so their fallbacks are decided before the migrations are
// written — not discovered mid-phase.
//
//   pnpm exec tsx scripts/neon-spike.ts
//
// Probes (each PASS/FAIL, summary at the end; exit 1 on any FAIL):
//   1. btree_gist EXCLUDE on (texts=, daterange &&)  — RateCard no-overlap
//   2. CREATE TEXT SEARCH CONFIGURATION (sv/en, unaccent + stem)
//   3. IMMUTABLE f_unaccent inside a GENERATED STORED tsvector column,
//      including the per-row `lang regconfig` variant (search_index)
//   4. pg_advisory_xact_lock through the POOLED connection (timer.ts)
//   5. Partial UNIQUE under ENABLE+FORCE RLS as app_runtime, including
//      two concurrent inserts (one-running-timer / one-open-shift)
//
// Everything lives in a throwaway schema (spike_<hex>) dropped in the
// cleanup, even on failure. The ONLY persistent change is
// CREATE EXTENSION IF NOT EXISTS btree_gist / unaccent — both are
// required by the upcoming migrations regardless; whether each was
// newly installed is reported. No product table is read or written;
// no tenant data is involved (probe rows carry fake tenant ids inside
// the throwaway schema only).
import { randomBytes } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { Client } from "pg";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const DIRECT_URL = process.env["DIRECT_URL"];
const DATABASE_URL = process.env["DATABASE_URL"];
if (!DIRECT_URL || !DATABASE_URL) {
  console.error("DIRECT_URL and DATABASE_URL must be set (.env.local)");
  process.exit(1);
}

const SCHEMA = `spike_${randomBytes(4).toString("hex")}`;
type Result = { probe: string; pass: boolean; note: string };
const results: Result[] = [];
const record = (probe: string, pass: boolean, note: string) => {
  results.push({ probe, pass, note });
  console.log(`${pass ? "PASS" : "FAIL"}  ${probe} — ${note}`);
};

const isPgError = (e: unknown): e is { code?: string; message: string } =>
  typeof e === "object" && e !== null && "message" in e;

async function main() {
  const owner = new Client({ connectionString: DIRECT_URL });
  await owner.connect();

  try {
    // ── Extensions (persistent by design — the migrations need them) ──
    const before = await owner.query(
      "SELECT extname FROM pg_extension WHERE extname IN ('btree_gist','unaccent')",
    );
    const had = new Set(before.rows.map((r: { extname: string }) => r.extname));
    await owner.query("CREATE EXTENSION IF NOT EXISTS btree_gist");
    await owner.query("CREATE EXTENSION IF NOT EXISTS unaccent");
    console.log(
      `extensions: btree_gist ${had.has("btree_gist") ? "already present" : "NEWLY INSTALLED"}, ` +
        `unaccent ${had.has("unaccent") ? "already present" : "NEWLY INSTALLED"}`,
    );

    await owner.query(`CREATE SCHEMA ${SCHEMA}`);

    // ── 1. btree_gist EXCLUDE (RateCard no-overlap incl. serviceId) ──
    try {
      await owner.query(`
        CREATE TABLE ${SCHEMA}.rate_probe (
          id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          tenant_id text NOT NULL,
          kind text NOT NULL,
          scope text NOT NULL,
          member_id text,
          project_id text,
          service_id text,
          effective_from date NOT NULL,
          effective_to date,
          EXCLUDE USING gist (
            tenant_id WITH =,
            kind WITH =,
            scope WITH =,
            coalesce(member_id, '') WITH =,
            coalesce(project_id, '') WITH =,
            coalesce(service_id, '') WITH =,
            daterange(effective_from, effective_to, '[)') WITH &&
          )
        )`);
      await owner.query(
        `INSERT INTO ${SCHEMA}.rate_probe (tenant_id, kind, scope, service_id, effective_from, effective_to)
         VALUES ('t1', 'BILL', 'SERVICE', 's1', '2026-01-01', '2026-06-01')`,
      );
      // Different service: must NOT collide.
      await owner.query(
        `INSERT INTO ${SCHEMA}.rate_probe (tenant_id, kind, scope, service_id, effective_from)
         VALUES ('t1', 'BILL', 'SERVICE', 's2', '2026-01-01')`,
      );
      let excluded = false;
      try {
        await owner.query(
          `INSERT INTO ${SCHEMA}.rate_probe (tenant_id, kind, scope, service_id, effective_from)
           VALUES ('t1', 'BILL', 'SERVICE', 's1', '2026-03-01')`,
        );
      } catch (e) {
        excluded = isPgError(e) && e.code === "23P01"; // exclusion_violation
      }
      record(
        "1 btree_gist EXCLUDE",
        excluded,
        excluded
          ? "overlap rejected (23P01); disjoint service ids coexist — EXCLUDE is the decided mechanism, no app-check fallback needed"
          : "overlapping insert was NOT rejected",
      );
    } catch (e) {
      record("1 btree_gist EXCLUDE", false, isPgError(e) ? e.message : String(e));
    }

    // ── 2. Text search configurations (sv/en, unaccent + stem) ──
    try {
      await owner.query(
        `CREATE TEXT SEARCH CONFIGURATION ${SCHEMA}.fortleva_sv (COPY = swedish)`,
      );
      await owner.query(
        `ALTER TEXT SEARCH CONFIGURATION ${SCHEMA}.fortleva_sv
           ALTER MAPPING FOR hword, hword_part, word
           WITH unaccent, swedish_stem`,
      );
      await owner.query(
        `CREATE TEXT SEARCH CONFIGURATION ${SCHEMA}.fortleva_en (COPY = english)`,
      );
      await owner.query(
        `ALTER TEXT SEARCH CONFIGURATION ${SCHEMA}.fortleva_en
           ALTER MAPPING FOR hword, hword_part, word
           WITH unaccent, english_stem`,
      );
      // Fair probes: same-stem pairs. Unaccent: 'fonster' ↔ 'Fönster'
      // (identical after unaccent, same stem). Stemming: 'rapport' ↔
      // 'rapporter' (-er strips). Do NOT test 'fönstren' vs 'fönster' —
      // snowball gives fönstr vs fönst even in plain Swedish.
      const svUnaccent = await owner.query(
        `SELECT to_tsvector('${SCHEMA}.fortleva_sv', 'Fönster och rapporter') @@ to_tsquery('${SCHEMA}.fortleva_sv', 'fonster') AS hit`,
      );
      const svStem = await owner.query(
        `SELECT to_tsvector('${SCHEMA}.fortleva_sv', 'Fönster och rapporter') @@ to_tsquery('${SCHEMA}.fortleva_sv', 'rapport') AS hit`,
      );
      const en = await owner.query(
        `SELECT to_tsvector('${SCHEMA}.fortleva_en', 'The windows were painted') @@ to_tsquery('${SCHEMA}.fortleva_en', 'window') AS hit`,
      );
      const ok =
        svUnaccent.rows[0].hit === true &&
        svStem.rows[0].hit === true &&
        en.rows[0].hit === true;
      record(
        "2 text search configs",
        ok,
        ok
          ? "fortleva_sv unaccents ('fonster' matches 'Fönster') and stems ('rapport' matches 'rapporter'); fortleva_en stems"
          : `sv unaccent hit=${svUnaccent.rows[0].hit} sv stem hit=${svStem.rows[0].hit} en hit=${en.rows[0].hit}`,
      );
    } catch (e) {
      record("2 text search configs", false, isPgError(e) ? e.message : String(e));
    }

    // ── 3. IMMUTABLE f_unaccent in a GENERATED STORED column ──
    try {
      await owner.query(`
        CREATE FUNCTION ${SCHEMA}.f_unaccent(text) RETURNS text
          LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
          RETURN public.unaccent('public.unaccent'::regdictionary, $1)`);
      await owner.query(`
        CREATE TABLE ${SCHEMA}.search_probe (
          id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          lang regconfig NOT NULL,
          title text NOT NULL,
          search tsvector GENERATED ALWAYS AS (
            to_tsvector(lang, ${SCHEMA}.f_unaccent(coalesce(title, '')))
          ) STORED
        )`);
      await owner.query(
        `INSERT INTO ${SCHEMA}.search_probe (lang, title)
         VALUES ('${SCHEMA}.fortleva_sv'::regconfig, 'Fönsterputsning på fredag'),
                ('${SCHEMA}.fortleva_en'::regconfig, 'Window cleaning on Friday')`,
      );
      const hit = await owner.query(
        `SELECT count(*)::int AS n FROM ${SCHEMA}.search_probe
          WHERE search @@ to_tsquery('${SCHEMA}.fortleva_sv', 'fonsterputsning')`,
      );
      const ok = hit.rows[0].n === 1;
      record(
        "3 IMMUTABLE f_unaccent + regconfig GENERATED column",
        ok,
        ok
          ? "generated tsvector with per-row lang regconfig works; f_unaccent(IMMUTABLE) accepted"
          : `expected 1 hit, got ${hit.rows[0].n}`,
      );
    } catch (e) {
      record(
        "3 IMMUTABLE f_unaccent + regconfig GENERATED column",
        false,
        isPgError(e) ? e.message : String(e),
      );
    }

    // ── 4. Advisory xact locks through the POOLER ──
    {
      const a = new Client({ connectionString: DATABASE_URL });
      const b = new Client({ connectionString: DATABASE_URL });
      try {
        await a.connect();
        await b.connect();
        await a.query("BEGIN");
        await a.query("SELECT pg_advisory_xact_lock(hashtext('spike-lock'))");
        const tryWhileHeld = await b.query(
          "BEGIN; SELECT pg_try_advisory_xact_lock(hashtext('spike-lock')) AS got",
        );
        // pg returns an array of results for multi-statement strings.
        const got = (Array.isArray(tryWhileHeld) ? tryWhileHeld[1] : tryWhileHeld)
          .rows[0].got as boolean;
        await b.query("COMMIT");
        await a.query("COMMIT");
        await b.query("BEGIN");
        const afterRelease = await b.query(
          "SELECT pg_try_advisory_xact_lock(hashtext('spike-lock')) AS got",
        );
        const gotAfter = afterRelease.rows[0].got as boolean;
        await b.query("COMMIT");
        const ok = got === false && gotAfter === true;
        record(
          "4 advisory xact lock via pooler",
          ok,
          ok
            ? "second session blocked while held, acquired after commit — transaction-scoped advisory locks work through the pooled URL"
            : `while-held got=${got} (want false), after-release got=${gotAfter} (want true)`,
        );
      } catch (e) {
        record("4 advisory xact lock via pooler", false, isPgError(e) ? e.message : String(e));
      } finally {
        await a.end().catch(() => {});
        await b.end().catch(() => {});
      }
    }

    // ── 5. Partial UNIQUE under FORCE RLS as app_runtime ──
    try {
      await owner.query(`
        CREATE TABLE ${SCHEMA}.shift_probe (
          id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          tenant_id text NOT NULL,
          member_id text NOT NULL,
          stopped_at timestamptz,
          deleted_at timestamptz
        )`);
      await owner.query(
        `CREATE UNIQUE INDEX shift_probe_one_open ON ${SCHEMA}.shift_probe
           (tenant_id, member_id) WHERE stopped_at IS NULL AND deleted_at IS NULL`,
      );
      await owner.query(`ALTER TABLE ${SCHEMA}.shift_probe ENABLE ROW LEVEL SECURITY`);
      await owner.query(`ALTER TABLE ${SCHEMA}.shift_probe FORCE ROW LEVEL SECURITY`);
      await owner.query(`
        CREATE POLICY tenant_isolation ON ${SCHEMA}.shift_probe
          AS PERMISSIVE FOR ALL TO app_runtime
          USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
          WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)))`);
      await owner.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO app_runtime`);
      await owner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${SCHEMA}.shift_probe TO app_runtime`,
      );

      const openInsert = async (c: Client) => {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.tenant_id', 'spike-t1', true)");
        await c.query(
          `INSERT INTO ${SCHEMA}.shift_probe (tenant_id, member_id) VALUES ('spike-t1', 'm1')`,
        );
      };

      // Sequential duplicate: second open insert must violate the index.
      const c1 = new Client({ connectionString: DATABASE_URL });
      await c1.connect();
      await openInsert(c1);
      await c1.query("COMMIT");
      let sequentialRejected = false;
      await c1.query("BEGIN");
      await c1.query("SELECT set_config('app.tenant_id', 'spike-t1', true)");
      try {
        await c1.query(
          `INSERT INTO ${SCHEMA}.shift_probe (tenant_id, member_id) VALUES ('spike-t1', 'm1')`,
        );
      } catch (e) {
        sequentialRejected = isPgError(e) && e.code === "23505";
        await c1.query("ROLLBACK");
      }
      // Closing the open row frees the slot.
      await c1.query("BEGIN");
      await c1.query("SELECT set_config('app.tenant_id', 'spike-t1', true)");
      await c1.query(
        `UPDATE ${SCHEMA}.shift_probe SET stopped_at = now() WHERE member_id = 'm1'`,
      );
      await c1.query(
        `INSERT INTO ${SCHEMA}.shift_probe (tenant_id, member_id) VALUES ('spike-t1', 'm1')`,
      );
      await c1.query("ROLLBACK");
      await c1.end();

      // Concurrent race: two open txs insert for the same member; the
      // second blocks on the index entry and errors when the first commits.
      const r1 = new Client({ connectionString: DATABASE_URL });
      const r2 = new Client({ connectionString: DATABASE_URL });
      await r1.connect();
      await r2.connect();
      await r1.query("BEGIN");
      await r1.query("SELECT set_config('app.tenant_id', 'spike-t1', true)");
      await r2.query("BEGIN");
      await r2.query("SELECT set_config('app.tenant_id', 'spike-t1', true)");
      await r1.query(
        `INSERT INTO ${SCHEMA}.shift_probe (tenant_id, member_id) VALUES ('spike-t1', 'm2')`,
      );
      const racing = r2
        .query(
          `INSERT INTO ${SCHEMA}.shift_probe (tenant_id, member_id) VALUES ('spike-t1', 'm2')`,
        )
        .then(() => "inserted" as const)
        .catch((e: unknown) =>
          isPgError(e) && e.code === "23505" ? ("unique" as const) : ("other" as const),
        );
      await new Promise((r) => setTimeout(r, 300)); // let r2 reach the lock
      await r1.query("COMMIT");
      const raceOutcome = await racing;
      await r2.query("ROLLBACK").catch(() => {});
      await r1.end();
      await r2.end();

      const ok = sequentialRejected && raceOutcome === "unique";
      record(
        "5 partial unique under FORCE RLS (app_runtime, pooled)",
        ok,
        ok
          ? "duplicate open row rejected (23505) sequentially AND under a concurrent race; closing the row frees the slot — DB-enforced one-open-row works as designed"
          : `sequentialRejected=${sequentialRejected}, raceOutcome=${raceOutcome}`,
      );
    } catch (e) {
      record(
        "5 partial unique under FORCE RLS (app_runtime, pooled)",
        false,
        isPgError(e) ? e.message : String(e),
      );
    }
  } finally {
    await owner
      .query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      .then(() => console.log(`cleanup: schema ${SCHEMA} dropped`))
      .catch((e: unknown) =>
        console.error(`cleanup FAILED for schema ${SCHEMA}:`, e),
      );
    await owner.end().catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  console.log(
    `\nspike summary: ${results.length - failed.length}/${results.length} passed` +
      (failed.length ? ` — FAILED: ${failed.map((f) => f.probe).join(", ")}` : ""),
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
