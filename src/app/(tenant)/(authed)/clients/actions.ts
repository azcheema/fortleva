"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { createClient } from "@/clients/service";
import { field, runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";

/** Inline create on /clients: name (+ optional org.nr). Enter creates the next. */
export async function createClientAction(
  _prev: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("clients.create");
  const name = field(formData, "name") ?? "";
  const r = await runForm("/clients", async () => {
    await createClient(
      { tenantId: membership.tenantId, actor },
      { name, orgNr: field(formData, "orgNr") },
    );
    return t("created", { name: name.trim() });
  });
  if (r.ok) revalidatePath("/clients");
  return r;
}
