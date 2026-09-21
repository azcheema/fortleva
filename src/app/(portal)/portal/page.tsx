import type { Metadata } from "next";
import { FolderOpenIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Callout, EmptyState, Page, PageHeader } from "@/components/semantic";
import { listPortalTasks } from "@/modules/work";
import { portalReadOrNull } from "@/portal";
import { requirePortalContext } from "@/portal/context";

import { PortalFrame } from "./portal-frame";
import { ProjectTasks } from "./task-list";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal");
  return { title: t("shortTitle") };
}

/**
 * `/portal` — THE FIRST REAL PORTAL ROUTE (memo slice 3).
 *
 * Everything the contact's client has been shared, as one list per
 * project. The pins' one-screen project page and the action-items rail
 * come later; what this proves today is the whole vertical: a contact
 * session → `requirePortalContext()` → `authorizePortal()` →
 * `withPortalRead` under the contact principal → an allow-listed
 * projection → a page that can render nothing else.
 *
 * ONE SURFACE FOR EVERY AUTHORIZATION REFUSAL, and this is the
 * load-bearing line of the file. `portalReadOrNull` turns every
 * `AuthzError` into `null`, and `null` renders the same empty state as a
 * client who genuinely has nothing shared. A contact of a tenant whose
 * plan does not include `work`, a contact of a tenant that switched the
 * portal off, a contact whose profile does not hold the capability, and
 * a contact whose agency simply has not shared anything yet all see the
 * same page, byte for byte. A denial reason is a fact about the AGENCY,
 * and the portal is the one surface where the agency's facts are not the
 * reader's to have. See `src/portal/render.ts`.
 *
 * **ADMISSION IS THE EXCEPTION, and the first draft of this comment got
 * it wrong in a way both fresh reviews caught independently.** It
 * claimed a SUSPENDED contact lands here too. It does not:
 * `requirePortalContext()` runs first, `requirePortalContact()` redirects
 * to /portal/login on any gate verdict but "ok"
 * (`portalGateDecision` → "not_active" / "unverified" / "incomplete"),
 * and `authorizePortal`'s own `FORBIDDEN "contact is not ACTIVE"` is
 * therefore unreachable from a page at all. That is the right behaviour —
 * a contact whose access was revoked must be signed out, not left
 * holding a usable session in front of an empty page — and what it
 * discloses is a fact about the READER, which they need in order to ask
 * for it back, and which signing in would tell them anyway. The rule is
 * therefore: **every authorization denial after admission is identical;
 * admission itself signs the contact out.**
 *
 * Which still means this page has no error branch and no "access denied"
 * copy to translate — the absence is the feature.
 */
export default async function PortalHome() {
  const { principal, name } = await requirePortalContext();
  const t = await getTranslations("portal");

  const list = await portalReadOrNull("listPortalTasks", () => listPortalTasks(principal));
  const projects = list?.projects ?? [];

  return (
    <PortalFrame name={name}>
      <Page>
        <div className="flex flex-col gap-6">
          <PageHeader title={t("title")} description={t("description")} />
          {projects.length === 0 ? (
            // `variant="forbidden"` is the honest one of the three and
            // needs no action, which matters here: §5.8 requires a
            // nothing-yet state to offer the verb that changes it, and on
            // this plane there is no such verb — a contact cannot share
            // their own agency's work with themselves. "Things exist,
            // not for you" is also exactly what this state means when it
            // is standing in for a denial. The glyph is overridden
            // because a shield says "you are blocked", which is the one
            // thing this page must never say.
            <EmptyState
              variant="forbidden"
              icon={FolderOpenIcon}
              title={t("empty.title")}
              body={t("empty.body")}
            />
          ) : (
            <>
              {list?.truncated ? (
                <Callout tone="info">{t("tasks.truncated", { count: list.shown })}</Callout>
              ) : null}
              {projects.map((project) => (
                <ProjectTasks key={project.projectId} project={project} />
              ))}
            </>
          )}
        </div>
      </Page>
    </PortalFrame>
  );
}
