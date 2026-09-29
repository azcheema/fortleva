import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requirePortalContext } from "@/portal/context";

import { PortalTaskView } from "./task-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal.task");
  // The one word, as the project page does — never the task's title (a
  // portal read, not worth a transaction before the page has decided
  // whether this contact may see the task) and never the URL segment,
  // which would make "not yours" and "nothing shared" differ in the one
  // place this plane keeps identical.
  return { title: t("title") };
}

/**
 * `/portal/tasks/[id]` — ONE SHARED TASK AND ITS CONVERSATION (Phase 3
 * slice 75; founder decision C41), and like every portal page since
 * View-as landed, a route that decides only WHO is asking. Everything
 * below the principal is `<PortalTaskView>`, the component
 * `/view-as/tasks/[id]` renders under a synthesised principal and
 * `e2e/view-as.spec.ts` byte-compares against this route.
 *
 * By id, not by number: a task's number is the agency's count of work
 * on the project ("ACME-340" says there are 340), which the portal has
 * never shown. The id is already on every task row's tick.
 */
export default async function PortalTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { principal, name } = await requirePortalContext();
  return <PortalTaskView principal={principal} name={name} taskId={id} />;
}
