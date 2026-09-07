import { record } from "@/audit/record";
import type { TenantDb } from "@/db";
import type { AppLocale } from "@/i18n/config";

/**
 * The one producer of `search.index_rebuilt` (DATA_MODEL §6.19).
 *
 * `search_index.lang` is stamped per row at feed time from the tenant's
 * locale, and `search` is a STORED column generated from it — so a
 * tenant that changed its language would otherwise keep every existing
 * row stemmed in the old one, findable only through words both stemmers
 * happen to agree on. This restamps `lang` for every row of the tenant
 * in the SAME transaction as the locale change, and Postgres recomputes
 * the tsvector as part of the UPDATE.
 *
 * ONE STATEMENT, and the config resolved ONCE in TypeScript. The
 * database's own `search_lang()` gives the same answer, but it is
 * SECURITY DEFINER with a pinned search_path, so Postgres neither
 * inlines nor constant-folds it: naming it in the statement would run
 * it twice per row (SET and WHERE) for an answer this caller already
 * holds. THE TWO MAPPINGS MUST AGREE, and neither one alone makes that
 * so: `CONFIG_OF` is exhaustive over `AppLocale`, so a new language
 * fails the build here — but `search_lang()` is a CASE in a migration
 * that nothing would force anyone to extend, and it fail-opens to
 * English, so the feed would stamp new rows `fortleva_en` while this
 * restamped the old ones to the new config and split the tenant's index
 * across two. The dbtest therefore walks EVERY member of `LOCALES` and
 * asserts the database agrees with this table, so adding a locale
 * without its migration fails a test rather than a tenant.
 *
 * `updated_at` is deliberately left alone: it is the ranking tiebreaker
 * for SOURCE freshness, and nothing about any source changed.
 *
 * COST is O(the tenant's indexed TEXT), inside the caller's transaction
 * budget, holding a row lock on every restamped row until commit — a
 * concurrent feed upsert of an EXISTING row waits behind it; creates do
 * not. The C tier is what governs that cost, and it is not empty by
 * design: `search_feed_comment` writes each comment's whole body and
 * `search_feed_work_item` writes `description_text`. Today neither has
 * a producer in the app (no comment service, and nothing writes a
 * description), so every real row is a title plus a key, an email or
 * tags — 201 such rows restamp in well under the 5 s default, which
 * preferences.dbtest measures and prints. Re-derive this from comment
 * volume once comments can be written. If a measured tenant crowds the
 * budget, the shape to move to is a chunked job under
 * `withTenant(tenantId, {type:'system'})`, NOT a wider budget — the
 * locks are exactly what a wider budget would hold for longer.
 *
 * A row fed by a transaction that read the OLD locale and commits after
 * this statement took its snapshot keeps the old config. That is why
 * the reader matches with each ROW's `lang` and probes every config the
 * tenant actually holds (query.ts): the restamp makes stragglers rare,
 * not impossible.
 *
 * Audited as `search.index_rebuilt {reason, from, to, rows}` — closed
 * enum locale keys and a count, never text — and only when a row
 * changed: an empty index has nothing to rebuild, and the locale change
 * itself is already `preference.changed {key: 'locale.default'}`.
 */
/** The text-search configuration each locale is indexed under. Schema
 * qualified, because `regconfig` resolves against the caller's
 * search_path. Exhaustive by type: a new `AppLocale` breaks the build
 * here rather than silently stemming that language as English. */
const CONFIG_OF: Record<AppLocale, string> = {
  sv: "public.fortleva_sv",
  en: "public.fortleva_en",
};

export async function restampSearchLang(
  tx: TenantDb,
  input: {
    readonly tenantId: string;
    /** Whatever the tenant row held — recorded, never acted on. */
    readonly from: string;
    /** Steers the UPDATE. */
    readonly to: AppLocale;
  },
): Promise<number> {
  const config = CONFIG_OF[input.to];
  const rows = await tx.$executeRaw`
    UPDATE search_index
       SET lang = ${config}::regconfig
     WHERE tenant_id = ${input.tenantId}
       AND lang IS DISTINCT FROM ${config}::regconfig`;
  if (rows > 0) {
    await record(tx, {
      action: "search.index_rebuilt",
      targetType: "Tenant",
      targetId: input.tenantId,
      metadata: { reason: "locale_changed", from: input.from, to: input.to, rows },
    });
  }
  return rows;
}
