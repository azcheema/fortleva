"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import { updatePreferences, VAULT_SEALED_WAIT_DAYS_RANGE } from "@/preferences/service";

const PATH = "/settings/vault";

/**
 * THE VAULT'S TWO WORKSPACE SWITCHES (Phase 3V slice 91) — share links
 * (slice 90's `vault.allowExternalShareLinks`, whose screen was owed) and
 * logins shown to clients (`vault.allowPortalCredentials`, C52 (d)). Each
 * only PARSES: the preference service checks the rest — `settings:edit`,
 * a fresh factor for any vault key (a stale one is the step-up page,
 * through `runForm`), `settings:manage_modules` ✦ to switch either ON, the
 * switch's lock — and switching OFF stops every share link for good, or
 * hides every shown login for good (C59 (b)).
 */
const switchSchema = z.object({
  key: z.enum(["shareLinks", "clientLogins", "clientSubmissions"]),
  on: z.boolean(),
});

/** Which preference each switch writes (slice 96 added clients sending logins, C64 — `settings:edit` both ways). */
const SWITCH_PATCH = {
  shareLinks: (on: boolean) => ({ vault: { allowExternalShareLinks: on } }),
  clientLogins: (on: boolean) => ({ vault: { allowPortalCredentials: on } }),
  clientSubmissions: (on: boolean) => ({ vault: { allowContactSubmission: on } }),
} as const;

export async function setVaultSwitchAction(raw: {
  key: "shareLinks" | "clientLogins" | "clientSubmissions";
  on: boolean;
}): Promise<FormResult> {
  const tCommon = await getTranslations("common");
  const parsed = switchSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("settings.vault");
  const { key, on } = parsed.data;
  const r = await runForm(PATH, async () => {
    await updatePreferences(ctx, SWITCH_PATCH[key](on));
    return t(`${key}.${on ? "switchedOn" : "switchedOff"}`);
  });
  if (r.ok) {
    revalidatePath(PATH);
    revalidatePath("/vault", "layout");
    revalidatePath("/clients", "layout");
    revalidatePath("/projects", "layout");
  }
  return r;
}

/**
 * THE SEALED LOGINS' WAIT (Phase 3V slice 93; founder decision C52 (g)):
 * how many days a client's ask waits for an answer before the client may
 * confirm it themselves — 7 to 60, 7 by default. `settings:edit` and a
 * fresh factor (the preference service's rule for every vault key). Each
 * ask freezes the wait it was made under, so a change moves no ask already
 * waiting.
 */
export async function setSealedWaitAction(days: number): Promise<FormResult> {
  const tCommon = await getTranslations("common");
  const parsed = z.number().int().min(VAULT_SEALED_WAIT_DAYS_RANGE.min).max(VAULT_SEALED_WAIT_DAYS_RANGE.max).safeParse(days);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("settings.vault.sealedWait");
  const r = await runForm(PATH, async () => {
    await updatePreferences({ tenantId: membership.tenantId, actor }, { vault: { sealedWaitDays: parsed.data } });
    return t("saved", { days: parsed.data });
  });
  if (r.ok) revalidatePath(PATH);
  return r;
}
