"use server";

import { redirect } from "next/navigation";

import { resolvePortalDownload } from "@/documents/portal-writes";
import { field } from "@/lib/server-actions";
import { runPortalAction } from "@/portal/action";
import { requirePortalContext } from "@/portal/context";

/**
 * DOWNLOAD A SHARED FILE — the portal's third server action, and the
 * first that reaches the file layer (Phase 3, the portal files slice).
 *
 * **THE PRINCIPAL COMES FROM `requirePortalContext()` AND FROM NOWHERE
 * ELSE** — the rule `requests/new/actions.ts` states at length and
 * `brokered-writes.test.ts` pins structurally. It matters here as it
 * does for the tick: View-as-Contact renders this form under a MEMBER
 * session (inert, so it cannot be submitted — but being unable to is
 * not the same as being safe), and an action that took its identity
 * from anywhere else would let a member inside View-as be audited as
 * downloading in their client's name. It cannot: no contact session is
 * found on a member request and the call redirects to `/portal/login`.
 *
 * **THE DOCUMENT ID IS AN ARGUMENT AND THAT IS SAFE, because it is not
 * an identity** — the same argument `setTaskDoneAction` makes for its
 * item id. `resolvePortalDownload` proves the row under the contact's
 * own principal (`authorizePortal` with a `document` ref) and then
 * restates the gate's every term in the system read; an id that does
 * not satisfy them is NOT_FOUND. It names WHICH row; it never widens
 * which rows are reachable.
 *
 * SUCCESS REDIRECTS OFF-ORIGIN, to the short-lived presigned URL with
 * `Content-Disposition: attachment` (SECURITY §5) — the same mechanism
 * the member plane's `downloadAction` uses, and called OUTSIDE the
 * runner because `redirect()` works by throwing.
 *
 * A REFUSAL LANDS BACK ON THE PAGE WITH ONE OF TWO WORDS. There is no
 * toast on this plane, so the page renders the refusal in place from
 * `?error=`. The word is `rate` for the one disclosable reason — the
 * contact's own download budget, a fact about themselves — and
 * `download` for everything else, because every other reason is a fact
 * about the agency (`src/portal/action.ts`'s bargain; the reason goes
 * to the server log). `returnTo` is the page the form was on and is
 * validated to a portal path: a same-plane, same-origin absolute path
 * or the files page, never an open redirect.
 */
const RETURN_TO = /^\/portal(?:\/[A-Za-z0-9._~-]+)*$/;

/**
 * A portal path, or the files page. The character class admits dots,
 * so a segment that IS a dot or two — `/portal/../login`, which the
 * browser would normalise off the portal plane — is refused separately
 * (code review): every segment must be a name, not a step.
 */
const returnToOf = (raw: string | null): string =>
  raw && RETURN_TO.test(raw) && !raw.split("/").some((segment) => segment === "." || segment === "..")
    ? raw
    : "/portal/files";

export async function downloadDocumentAction(formData: FormData): Promise<void> {
  const documentId = field(formData, "documentId") ?? "";
  const returnTo = returnToOf(field(formData, "returnTo"));
  const { principal } = await requirePortalContext();
  const result = await runPortalAction("downloadDocument", () => resolvePortalDownload(principal, documentId));
  if (!result.ok) {
    redirect(`${returnTo}?error=${result.code === "DOWNLOAD_RATE_LIMITED" ? "rate" : "download"}`);
  }
  redirect(result.value.url);
}
