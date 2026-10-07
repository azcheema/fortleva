"use server";

import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { field, type FormResult } from "@/lib/server-actions";
import { declinePortalLoginAsk, submitPortalCredential } from "@/modules/vault";
import { runPortalAction } from "@/portal/action";
import { requirePortalContext } from "@/portal/context";

/**
 * HAND A LOGIN OVER (Phase 3V slice 96; founder decision C64) — the
 * "Send us a login" form's action.
 *
 * THE PRINCIPAL COMES FROM `requirePortalContext()` AND FROM NOWHERE ELSE,
 * the portal's standing rule (`requests/new/actions.ts` has the long form):
 * nothing that names a tenant, a client or a contact is read out of the
 * form, and a member inside View-as — who has no contact session — is sent
 * to the client sign-in page. The client the login lands on is the
 * principal's; the form may carry two ids — the PROJECT, which the broker
 * proves is this contact's to name (`authorizePortal` on the project) and
 * re-reads as this client's, or, in answer to an ask (slice 98), the ASK,
 * which the broker accepts only as one of this contact's own open asks and
 * whose project then wins over any on the form.
 *
 * TWO REFUSALS ARE SAID HERE, BEFORE THE BROKER, because they are about
 * what the reader typed and a plain "check what you typed" would not tell
 * them which: no name, and no secret. Everything else is the broker's —
 * `runPortalAction` turns every refusal about the agency into the plane's one
 * message and says only the reader's own (`INVALID_INPUT`,
 * `SUBMISSION_RATE_LIMITED`).
 *
 * SUCCESS REDIRECTS FROM THE SERVER to the same page with `?sent=1`, which
 * says it went and shows it at the top of their list — a fresh render, so
 * the form is empty again and no secret lingers in the browser's state.
 * Outside the runner, because `redirect()` works by throwing.
 */
export async function sendLoginAction(_prev: FormResult | null, formData: FormData): Promise<FormResult> {
  const { principal } = await requirePortalContext();
  const t = await getTranslations("portal.sendLogin.errors");

  // A null-prototype map: a field named `secret.__proto__` must be a key
  // like any other (the broker refuses it), never the object's prototype.
  const secret = Object.create(null) as Record<string, string>;
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("secret.") && typeof value === "string") secret[key.slice("secret.".length)] = value;
  }
  const name = field(formData, "name") ?? "";
  if (name.trim() === "") return { ok: false, message: t("name") };
  if (!Object.values(secret).some((v) => v.length > 0)) return { ok: false, message: t("secret") };
  // An answer to one of the agency's asks (slice 98, C66): the broker lands
  // it where the ASK says and ignores any project on the form.
  const askId = field(formData, "askId");

  const result = await runPortalAction("sendLogin", async () => {
    await submitPortalCredential(principal, {
      type: field(formData, "type"),
      name,
      projectId: field(formData, "projectId"),
      askId,
      username: field(formData, "username"),
      url: field(formData, "url"),
      notes: field(formData, "notes"),
      secret,
    });
    // Never rendered: the redirect below runs on every success.
    return "";
  });
  if (result.ok) redirect("/portal/send-login?sent=1");
  // IN ANSWER TO AN ASK, a refusal about the agency most likely means the
  // ask closed while the form was open (the team cancelled it, or it was
  // answered in another tab) — the design review's nit: say so, and the
  // typed values stay in the form. It discloses nothing new: the page
  // itself says "no longer open" for every ask it cannot show, whatever
  // the reason. A disclosable refusal (what they typed, their pace) keeps
  // its own words.
  if (askId && !result.code) return { ok: false, message: (await getTranslations("portal.sendLogin.ask"))("refused") };
  return { ok: false, message: result.message };
}

/**
 * "WE DON'T HAVE THIS" (Phase 3V slice 98; founder decision C66 (c)) — the
 * contact the agency asked declines, with an optional note. The principal
 * comes from `requirePortalContext()` and nowhere else; the form carries
 * the ask's id, which the broker accepts only as one of THIS contact's own
 * open asks. Success redirects to the page with `?declined=1`.
 */
export async function declineLoginAskAction(_prev: FormResult | null, formData: FormData): Promise<FormResult> {
  const { principal } = await requirePortalContext();
  const result = await runPortalAction("declineLoginAsk", async () => {
    await declinePortalLoginAsk(principal, field(formData, "askId"), field(formData, "note"));
    return "";
  });
  if (result.ok) redirect("/portal/send-login?declined=1");
  if (!result.code) return { ok: false, message: (await getTranslations("portal.sendLogin.decline"))("refused") };
  return { ok: false, message: result.message };
}
