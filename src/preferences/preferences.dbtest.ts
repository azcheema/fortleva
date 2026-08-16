import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest setup/cleanup uses the raw layer */
import { getPlatformClient } from "@/db/client";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { setupTenant } from "@/members/dbtest-fixture";

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
  await getPlatformClient().tenantPreference.deleteMany({ where: { tenantId: t.tenantId } });
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
