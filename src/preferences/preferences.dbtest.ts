import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest setup/cleanup uses the raw layer */
import { getPlatformClient } from "@/db/client";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { setupTenant } from "@/members/dbtest-fixture";

import { LOCALES } from "@/i18n/config";

import {
  getPreferences,
  setModuleEnabled,
  updatePreferences,
  type PreferenceCtx,
} from "./service";

/**
 * Preferences service against the real DB: settings:view / settings:edit
 * gates, Tenant.defaultLocale written on the tenant row, TenantPreference
 * keys, audit rows carry {key} only, and the module toggle really trips
 * gate 3 (DISABLED_BY_TENANT) for the module's permissions.
 */

let t: Awaited<ReturnType<typeof setupTenant>>;
let owner: PreferenceCtx;
let employee: PreferenceCtx;

beforeAll(async () => {
  t = await setupTenant("prefs");
  owner = { tenantId: t.tenantId, actor: t.seats.owner.actor };
  employee = { tenantId: t.tenantId, actor: t.seats.employee.actor };
});

afterAll(async () => {
  // A failed beforeAll leaves `t` unassigned, and Prisma DROPS an
  // undefined where-filter (the 2026-08-31 wipe) — nothing tenant-scoped
  // exists in that case anyway.
  if (t === undefined) return;
  const p = getPlatformClient();
  // The clients the rebuild test fed; client.tenant_id RESTRICTs the
  // tenant delete in cleanup(), which also sweeps search_index.
  await p.client.deleteMany({ where: { tenantId: t.tenantId } });
  await p.tenantPreference.deleteMany({ where: { tenantId: t.tenantId } });
  await t.cleanup();
});

describe("preferences", () => {
  it("employee cannot read (settings:view) or write (settings:edit)", async () => {
    await expect(getPreferences(employee)).rejects.toMatchObject({ reason: "FORBIDDEN" });
    await expect(updatePreferences(employee, { weekStart: "SUNDAY" })).rejects.toMatchObject({
      reason: "FORBIDDEN",
    });
  });

  it("owner reads defaults, writes locale on the tenant row and the rest as keyed rows; audit has keys only", async () => {
    const before = await getPreferences(owner);
    expect(before.timezone).toBe("Europe/Stockholm");
    const changed = await updatePreferences(owner, {
      defaultLocale: "en",
      timezone: "America/Chicago",
      showIsoWeek: false,
      currencyDefault: "EUR",
    });
    expect(changed.sort()).toEqual(
      ["finance.currencyDefault", "locale.default", "ui.showIsoWeek", "ui.timezone"].sort(),
    );
    const tenant = await getPlatformClient().tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    expect(tenant.defaultLocale).toBe("en");
    const rows = await getPlatformClient().tenantPreference.findMany({ where: { tenantId: t.tenantId } });
    expect(new Map(rows.map((r) => [r.key, r.value]))).toEqual(
      new Map<string, unknown>([
        ["ui.timezone", "America/Chicago"],
        ["ui.showIsoWeek", false],
        ["finance.currencyDefault", "EUR"],
      ]),
    );
    const after = await getPreferences(owner);
    expect(after).toMatchObject({
      defaultLocale: "en",
      timezone: "America/Chicago",
      showIsoWeek: false,
      currencyDefault: "EUR",
      weekStart: "MONDAY",
    });
    const audits = await t.audits("preference.changed");
    expect(audits.length).toBe(4);
    for (const a of audits) {
      const meta = a.metadata as Record<string, unknown>;
      expect(Object.keys(meta)).toEqual(["key"]);
    }
    // Same value again ⇒ no write, no audit row.
    expect(await updatePreferences(owner, { timezone: "America/Chicago" })).toEqual([]);
    expect((await t.audits("preference.changed")).length).toBe(4);
  });

  it("module toggle: ✦ settings:manage_modules; off ⇒ gate 3 denies the module's permissions", async () => {
    await expect(setModuleEnabled(employee, "portal", false)).rejects.toMatchObject({
      reason: "FORBIDDEN",
    });
    await expect(
      setModuleEnabled({ tenantId: t.tenantId, actor: { memberId: t.seats.owner.memberId } }, "portal", false),
    ).rejects.toMatchObject({ reason: "MFA_REQUIRED" });

    await setModuleEnabled(owner, "portal", false);
    expect((await getPreferences(owner)).modules.portal).toBe(false);
    await withTenant(t.tenantId, { type: "member", id: t.seats.owner.memberId }, async (tx) => {
      await expect(
        requireAccess(tx, t.tenantId, t.seats.owner.actor, "client:manage_contacts"),
      ).rejects.toMatchObject({ reason: "DISABLED_BY_TENANT" });
    });
    await setModuleEnabled(owner, "portal", true);
    await withTenant(t.tenantId, { type: "member", id: t.seats.owner.memberId }, async (tx) => {
      await requireAccess(tx, t.tenantId, t.seats.owner.actor, "client:manage_contacts");
    });
  });
});

describe("the search index follows the workspace language (search/rebuild.ts)", () => {
  /**
   * Every search_index row is stemmed in the language it was FED in
   * (`lang` per row, `search` STORED and generated from it). A locale
   * change must restamp them in the same transaction — else a Swedish
   * workspace that switches to English keeps searching yesterday's rows
   * with today's stemmer — and must say so once, in the audit log, with
   * a row count and nothing else.
   *
   * The probe word is "running": english_stem reduces it to 'run',
   * swedish_stem leaves it whole, so an English query for 'run' finds
   * the row ONLY if the stored tsvector was regenerated under the new
   * config. Comparing `lang` alone would pass with a stale vector.
   *
   * The fixture tenant holds no index rows at provisioning (nothing the
   * six feed triggers watch is created), so the file's earlier locale
   * flip wrote NO search.index_rebuilt row — the zero-row rule the last
   * test pins. Every count below is a delta all the same.
   */
  const suffix = randomUUID().slice(0, 8).replace(/-/g, "");
  const BULK = 200;
  const p = () => getPlatformClient();

  const rows = async () => {
    const r = await p().$queryRaw<{ n: number; sv: boolean | null; en: boolean | null; agrees: boolean | null }[]>`
      SELECT count(*)::int AS n,
             bool_and(lang = 'public.fortleva_sv'::regconfig) AS sv,
             bool_and(lang = 'public.fortleva_en'::regconfig) AS en,
             -- the TypeScript CASE and the trigger's search_lang() must
             -- never disagree; this is where drift would show
             bool_and(lang = search_lang(tenant_id)) AS agrees
        FROM search_index
       WHERE tenant_id = ${t.tenantId}`;
    return r[0]!;
  };
  /** Does an ENGLISH-stemmed query find the "Running repairs" client? */
  const englishFinds = async (): Promise<boolean> => {
    const r = await p().$queryRaw<{ hit: boolean | null }[]>`
      SELECT bool_or(search @@ to_tsquery('public.fortleva_en', 'run')) AS hit
        FROM search_index
       WHERE tenant_id = ${t.tenantId} AND entity_type = 'CLIENT'`;
    return r[0]?.hit === true;
  };
  const rebuilds = () => t.audits("search.index_rebuilt");

  it("restamps every row's lang in the locale-change transaction and regenerates the tsvector", async () => {
    // A KNOWN starting language, set raw so it writes no event of its own.
    await p().tenant.update({ where: { id: t.tenantId }, data: { defaultLocale: "sv" } });
    await p().client.create({ data: { tenantId: t.tenantId, name: `Running repairs ${suffix}` } });
    await p().client.createMany({
      data: Array.from({ length: BULK }, (_, i) => ({ tenantId: t.tenantId, name: `Bulk client ${i} ${suffix}` })),
    });
    let r = await rows();
    expect(r.n).toBe(BULK + 1);
    expect(r.sv).toBe(true); // fed from the tenant's locale by search_lang()
    expect(r.agrees).toBe(true);
    expect(await englishFinds()).toBe(false); // 'running' under swedish_stem is not 'run'
    const before = (await rebuilds()).length;

    const started = performance.now();
    const changed = await updatePreferences(owner, { defaultLocale: "en" });
    const elapsedMs = Math.round(performance.now() - started);
    expect(changed).toEqual(["locale.default"]);

    r = await rows();
    expect(r.n).toBe(BULK + 1);
    expect(r.en).toBe(true);
    expect(r.agrees).toBe(true);
    // The STORED column was regenerated, not merely relabelled.
    expect(await englishFinds()).toBe(true);

    const after = await rebuilds();
    expect(after.length).toBe(before + 1);
    const event = after.at(-1)!;
    expect(event.targetType).toBe("Tenant");
    expect(event.targetId).toBe(t.tenantId);
    expect(event.actorId).toBe(t.seats.owner.memberId);
    // Enum keys and a count — no text.
    expect(event.metadata).toEqual({ reason: "locale_changed", from: "sv", to: "en", rows: BULK + 1 });
    // Read as a measurement, not a pass: the restamp runs inside the
    // settings save's default 5 s budget (search/rebuild.ts).
    console.info(`[search/rebuild] ${BULK + 1} rows restamped; updatePreferences took ${elapsedMs} ms`);
  });

  it("goes both ways, writes nothing for a no-op, and writes NO event when no row was restamped", async () => {
    const before = (await rebuilds()).length;
    expect(await updatePreferences(owner, { defaultLocale: "sv" })).toEqual(["locale.default"]);
    const r = await rows();
    expect(r.sv).toBe(true);
    expect(r.agrees).toBe(true);
    const back = await rebuilds();
    expect(back.length).toBe(before + 1);
    expect(back.at(-1)!.metadata).toEqual({ reason: "locale_changed", from: "en", to: "sv", rows: BULK + 1 });

    // Same value again: nothing written, nothing audited (this file's rule).
    expect(await updatePreferences(owner, { defaultLocale: "sv" })).toEqual([]);
    expect((await rebuilds()).length).toBe(before + 1);

    // An empty index has nothing to rebuild. The locale change is still
    // preference.changed; no search.index_rebuilt claims a rebuild that
    // touched no row.
    await p().$executeRaw`DELETE FROM search_index WHERE tenant_id = ${t.tenantId}`;
    const prefsBefore = (await t.audits("preference.changed")).length;
    expect(await updatePreferences(owner, { defaultLocale: "en" })).toEqual(["locale.default"]);
    expect((await t.audits("preference.changed")).length).toBe(prefsBefore + 1);
    expect((await rebuilds()).length).toBe(before + 1);
  });
});

describe("the app's locale→config table and the database's own must agree", () => {
  /**
   * `restampSearchLang` maps a locale to a text-search configuration in
   * TypeScript; the six feed triggers map it again in SQL, through
   * `search_lang()`. Both are needed and only one of them is
   * type-checked: adding a locale breaks the build at `CONFIG_OF`, but
   * `search_lang()` is a CASE in a migration, and it FAILS OPEN to
   * English. A locale added without that migration would leave the
   * restamp writing the new config while every row fed afterwards got
   * `fortleva_en` — one tenant's index split across two configs, which
   * is the exact stranding the restamp exists to prevent.
   *
   * So this walks every locale the app offers and asks the database
   * what it would stamp. It passes today; it fails the day someone adds
   * a language and forgets the migration, which is the only moment it
   * could ever be useful.
   */
  it("search_lang() answers for every member of LOCALES, not just the two that happen to agree", async () => {
    const p = getPlatformClient();
    const original = (await p.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).defaultLocale;
    try {
      for (const locale of LOCALES) {
        await p.tenant.update({ where: { id: t.tenantId }, data: { defaultLocale: locale } });
        // Compared AS regconfig, never as text: `regconfig`'s text form
        // is schema-qualified only when the config is not visible on the
        // caller's search_path, so a text comparison asserts the
        // connection's search_path as much as the mapping.
        const [row] = await p.$queryRaw<{ ok: boolean }[]>`
          SELECT search_lang(${t.tenantId}) = ${`public.fortleva_${locale}`}::regconfig AS ok`;
        expect(row?.ok, `search_lang() must answer fortleva_${locale} for locale "${locale}"`).toBe(true);
      }
    } finally {
      await p.tenant.update({ where: { id: t.tenantId }, data: { defaultLocale: original } });
    }
  });
});
