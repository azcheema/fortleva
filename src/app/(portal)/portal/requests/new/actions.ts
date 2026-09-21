"use server";

import { redirect } from "next/navigation";

import { createPortalRequest } from "@/modules/work";
import { runPortalForm } from "@/portal/action";
import { requirePortalContext } from "@/portal/context";
import { field, type FormResult } from "@/lib/server-actions";

/**
 * THE PORTAL'S FIRST SERVER ACTION — and the first place a contact
 * causes a row to exist.
 *
 * **THE PRINCIPAL COMES FROM `requirePortalContext()` AND FROM NOWHERE
 * ELSE.** That sentence is the member plane's standing rule ("server
 * actions derive tenant and member from `requireTenantContext()`, never
 * from form parameters" — AGENTS.md) and it is load-bearing twice over
 * here. Once for the obvious reason: a `tenantId` or a `contactId` in a
 * `FormData` is a field the browser fills in. And once for a reason that
 * is specific to this plane — View-as-Contact renders the portal's own
 * components under a MEMBER session, so if this action took its
 * principal from anywhere but the contact cookie, a member inside
 * View-as could write rows attributed to the client they are looking
 * through. It cannot: `requirePortalContext()` finds no contact session
 * on a member request and redirects to /portal/login, so the View-as
 * surface is read-only by construction rather than by a check somebody
 * has to remember. `src/portal/brokered-writes.test.ts` pins both halves
 * structurally — the call must be here, and no identity may be read out
 * of the form.
 *
 * `runPortalForm` rather than `runForm`: on this plane a denial's REASON
 * is a fact about the agency (`src/portal/action.ts`), so every
 * authorization failure comes back as one message and the reason goes to
 * the server log.
 *
 * **SUCCESS REDIRECTS FROM THE SERVER, and the first cut got this
 * wrong.** It returned a message and had the form navigate with
 * `router.push("/portal")` after a `router.refresh()` — but
 * `refresh()` clears the Client Cache **for the current route**, which
 * is this form's, not the destination's (Next 16, `use-router.md`), so
 * the comment explaining it was describing something the call does not
 * do. A server `redirect()` is the mechanism that actually applies: the
 * action's own response carries the destination's fresh RSC payload, it
 * needs no effect in the client component, and it degrades to a 303 when
 * JavaScript is unavailable. It is called OUTSIDE the runner, because
 * `redirect()` works by throwing and a `try` that swallowed it would
 * turn a navigation into a silent success.
 *
 * NO `revalidatePath`: the redirect already re-renders `/portal`, and
 * AGENTS.md's standing trap is that a transition around an action that
 * revalidates stays pending until the whole revalidated page has
 * re-rendered.
 */
export async function submitRequestAction(
  _prev: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const { principal } = await requirePortalContext();
  const result = await runPortalForm("submitRequest", async () => {
    await createPortalRequest(principal, {
      projectId: field(formData, "projectId") ?? "",
      title: field(formData, "title") ?? "",
      body: field(formData, "body"),
    });
    // Never rendered: the redirect below runs on every success. The
    // runner's contract is a message, so this is the shape rather than
    // the copy.
    return "";
  });
  if (result.ok) redirect("/portal");
  return result;
}
