"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import { updatePreferences } from "@/preferences/service";

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
  key: z.enum(["shareLinks", "clientLogins"]),
  on: z.boolean(),
});

export async function setVaultSwitchAction(raw: { key: "shareLinks" | "clientLogins"; on: boolean }): Promise<FormResult> {
  const tCommon = await getTranslations("common");
  const parsed = switchSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("settings.vault");
  const { key, on } = parsed.data;
  const r = await runForm(PATH, async () => {
    await updatePreferences(
      ctx,
      key === "shareLinks" ? { vault: { allowExternalShareLinks: on } } : { vault: { allowPortalCredentials: on } },
    );
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
