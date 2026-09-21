"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { requireMemberSession } from "@/auth/session";
import { clearViewAsContact, setViewAsContact } from "@/auth/view-as";
import { enterViewAs } from "@/clients/view-as";
import { VIEW_AS_PREFIX } from "@/config/view-as";
import { requireTenantContext } from "@/members/tenant-context";
import { runForm, type FormResult } from "@/lib/server-actions";

/**
 * ENTER VIEW-AS-CONTACT — the act `project.viewed_as_contact` records.
 *
 * A POST rather than a link, and that is the whole reason the audit row
 * can claim to fire once per ENTRY. Next PREFETCHES `<Link>`s in
 * production, so a GET that entered the mode would write a row when a
 * member's mouse crossed the button — one row per hover, in production
 * only, invisible to every local test. Slice 4 declined to audit its
 * static preview panel for the neighbouring reason (a page render is
 * not an act, and Next re-runs one on prefetch, revalidation and
 * refresh); this is the shape that has no such problem.
 *
 * THE IDS ARE PARAMETERS AND THAT IS NOT A BREACH of "server actions
 * derive tenant and member from `requireTenantContext()`". The TENANT
 * and the MEMBER come from the session, as always. The contact and the
 * project are the SUBJECT of the act, and `enterViewAs` trusts neither:
 * it re-reads the contact under the member's own RLS-scoped
 * transaction, checks `project:manage_portal`, checks that the member
 * reaches the whole CLIENT (`assertInScope` with no `lifted`), checks
 * that the contact could actually sign in, and checks the project too —
 * because that id ends up in the tenant's own audit log and a member
 * must not be able to write a project they cannot see into it. The
 * identical argument the workspace picker makes for its `tenantId`.
 *
 * ORDER: AUTHORISE AND AUDIT FIRST, POINT THE SESSION SECOND. If the
 * pointer write failed after a successful audit we would hold a row
 * describing an entry that did not happen — over-recording, which is
 * the safe direction and is visibly so in the log. The reverse order
 * would leave a member inside a client's view with no row at all, which
 * is the one failure an audited control cannot have.
 *
 * IT RETURNS A TYPED RESULT AND DOES NOT REDIRECT, which is the house
 * rule for a control that can be refused (AGENTS.md's standing trap: an
 * action failure must never look like a revert). The refusals here are
 * real and not theoretical — the contact suspended, the role narrowed
 * or the client unassigned between the render that drew the button and
 * the click — and `runForm` turns each into a toastable sentence
 * instead of a bounce to a page with a query parameter nothing reads.
 * The caller navigates on success (`view-as-button.tsx`).
 *
 * `revalidatePath("/", "layout")` for PARITY with the workspace switch,
 * which is the honest reason and not the one the first draft gave. That
 * draft called it load-bearing because "the whole request's LOCALE
 * changes with the pointer" — it does not: the locale is keyed on the
 * ROUTE, which is the entire argument in `src/config/view-as.ts`, and
 * `/view-as` is dynamic (`ƒ`), so no segment anywhere can be cached
 * under the wrong language (code review). What it actually does is drop
 * client-side router entries for a session whose identity the member has
 * just changed the meaning of, cheaply and once per act.
 */
export async function enterViewAsAction(
  contactId: string,
  fromProjectId: string,
): Promise<FormResult> {
  const session = await requireMemberSession();
  const { membership, actor } = await requireTenantContext();

  // `runForm`'s first argument is the step-up return path, and it is a
  // CONSTANT rather than the project the caller named. An earlier cut
  // took the project KEY as a third parameter and interpolated it here —
  // caller-controlled data reaching a redirect builder, in the file
  // whose docblock below boasts that the slice carries no return path
  // for exactly that reason (code review). Not exploitable (`safeNextPath`
  // refuses `//` and the value was always `/projects/`-prefixed) and
  // unreachable (`project:manage_portal` is not a ✦ code), but a claim
  // that contradicts itself one screen later is worth more than the UX.
  return runForm(VIEW_AS_PREFIX, async () => {
    const target = await enterViewAs({ tenantId: membership.tenantId, actor }, {
      contactId,
      fromProjectId,
    });
    await setViewAsContact({
      sessionId: session.session.id,
      userId: session.user.id,
      contactId: target.contactId,
    });
    revalidatePath("/", "layout");
    const t = await getTranslations("viewAs");
    return t("entered", { name: target.name });
  });
}

/**
 * LEAVE — and it must never fail.
 *
 * `clearViewAsContact` uses `updateMany` precisely so that a session
 * already expired, revoked from another device or cleared by a second
 * tab cannot turn "get me out of this client's view" into a 500. There
 * is no authorization here and there must not be: a member who has just
 * LOST `project:manage_portal` is exactly the person who most needs
 * this button to work, and `/view-as` is already refusing to render
 * anything for them. It is the one control in the product whose
 * correct behaviour is to succeed unconditionally.
 *
 * A plain redirecting form action rather than a typed result, for the
 * same reason: there is no failure to report. `/home` and not the
 * project the member came from — the mode spans a CLIENT and this slice
 * deliberately carries no return path, because the only way to have one
 * is a parameter on a security-sensitive route that a reviewer must
 * then check for open redirection. Named in PLAN §0 as a small, known
 * cost rather than left to be discovered.
 *
 * NOT AUDITED. There is no `project.view_as_ended` in the catalogue and
 * this slice does not invent one: an audit action cannot be backfilled,
 * so `impersonation.started`/`impersonation.ended` sitting together as a
 * paired precedent makes it a question worth the founder answering
 * rather than a call to make here. What the log says today is when a
 * member entered and as whom, which is the fact SECURITY.md §5.1 asks
 * for; how long they stayed is a question nobody has had to answer yet.
 */
export async function exitViewAsAction(): Promise<void> {
  const session = await requireMemberSession();
  await clearViewAsContact({ sessionId: session.session.id, userId: session.user.id });
  revalidatePath("/", "layout");
  redirect("/home");
}
