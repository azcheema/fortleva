"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { verifyStepUpWithHeaders } from "@/auth/step-up";
import { enrolUrl } from "@/authz/redirects";
import { field, runAction, type ActionResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import { CREDENTIAL_TYPES, exportCredentials, type CredentialType, type ExportLabels, type ExportScope } from "@/modules/vault";

import { AGENCY_WHERE } from "./surface";
import { fieldLabelKey, SECRET_FIELD_KEYS } from "./vault-shape";

/**
 * EXPORT LOGINS (Phase 3V slice 95; founder decision C63) — `/vault`'s
 * "Export…". Exporting ALWAYS asks for a fresh factor (AUTHZ.md §7.5, CP4),
 * so the dialog carries the member's authenticator code, verified HERE
 * through the product's one step-up door just before the service runs —
 * the share form's shape; the service then wants a factor no older than a
 * minute, and checks everything else itself.
 *
 * The file comes back in the answer and the browser saves it; nothing is
 * kept on the server. The dialog calls this DIRECTLY rather than through
 * `useActionState`, so the plaintext is never held in React state.
 */

export type ExportedFile = {
  readonly csv: string;
  readonly filename: string;
  readonly count: number;
  /** Values a spreadsheet would run as formulas — the dialog warns when there are any. */
  readonly formulaValues: number;
  /** Logins too long for Bitwarden to import, by name — the dialog names them. */
  readonly tooLong: readonly string[];
};

const uuid = z.uuid();

/** The dialog's "What to export": "" for everything, `agency` for our own, or a client's id. */
function scopeOf(raw: string | null): ExportScope | null {
  if (raw === null || raw === "") return { kind: "all" };
  if (raw === AGENCY_WHERE) return { kind: "agency" };
  return uuid.safeParse(raw).success ? { kind: "client", clientId: raw.toLowerCase() } : null;
}

/** The words the file is written in — the exporting member's language. */
async function labelsOf(): Promise<ExportLabels> {
  const t = await getTranslations("vault");
  const tFile = await getTranslations("vault.export.file");
  return {
    product: tFile("product"),
    types: Object.fromEntries(CREDENTIAL_TYPES.map((type) => [type, t(`types.${type}`)])) as Record<CredentialType, string>,
    fields: Object.fromEntries(SECRET_FIELD_KEYS.map((key) => [key, t(fieldLabelKey(key))])),
    project: tFile("project"),
    username: tFile("username"),
    url: tFile("url"),
    totp: tFile("totp"),
    tags: tFile("tags"),
    expires: tFile("expires"),
    rotateEvery: (days) => tFile("rotateEvery", { days }),
    lastChanged: tFile("lastChanged"),
    changeSoon: tFile("changeSoon"),
    shownToClient: tFile("shownToClient"),
    sealed: tFile("sealed"),
    archived: tFile("archived"),
  };
}

export async function exportLoginsAction(formData: FormData): Promise<ActionResult<ExportedFile>> {
  const scope = scopeOf(field(formData, "which"));
  if (scope === null) return { ok: false, message: (await getTranslations("common"))("invalidInput") };
  const t = await getTranslations("vault.export");
  const code = (field(formData, "code") ?? "").trim();
  if (code.length < 6 || code.length > 32) return { ok: false, message: t("enterCode") };

  const { membership, actor } = await requireTenantContext();
  const verified = await verifyStepUpWithHeaders(code, await headers());
  if (!verified.ok) {
    if (verified.reason === "no_session") redirect("/login");
    if (verified.reason === "not_enrolled") redirect(enrolUrl("/vault"));
    const tStep = await getTranslations("account.stepUp");
    return { ok: false, message: verified.reason === "rate_limited" ? tStep("tooManyAttempts") : tStep("mismatch") };
  }
  const ctx = {
    tenantId: membership.tenantId,
    actor: { ...actor, mfa: { enrolled: true, verifiedAt: verified.verifiedAt } },
  };
  const labels = await labelsOf();
  const r = await runAction("/vault", () => exportCredentials(ctx, scope, labels));
  if (!r.ok) return r;
  // The server's calendar day (UTC) — never the process zone's (AGENTS.md's date trap).
  const day = new Date().toISOString().slice(0, 10);
  return {
    ok: true,
    value: {
      csv: r.value.csv,
      count: r.value.count,
      formulaValues: r.value.formulaValues,
      tooLong: r.value.tooLong,
      filename: `fortleva-logins-${day}.csv`,
    },
  };
}
