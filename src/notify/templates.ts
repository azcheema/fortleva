import { appUrl } from "@/config";
import type { NotificationKind } from "./catalog";

/**
 * Minimal 2W email rendering — deliberately tiny: emails carry LINKS,
 * not data (ARC-09). Subject/body are generic per kind + locale; the
 * deep link is built from ids in `params`. Proper templating (digests,
 * rich bodies) is Phase 5; adding a kind here without both locales is a
 * type error.
 */

type Copy = { readonly subject: string; readonly body: string };

const COPY: Record<NotificationKind, Record<"en" | "sv", Copy>> = {
  "work_item.assigned": {
    en: { subject: "A task was assigned to you", body: "A task in Fortleva was assigned to you." },
    sv: { subject: "En uppgift tilldelades dig", body: "En uppgift i Fortleva tilldelades dig." },
  },
  "comment.mentioned": {
    en: { subject: "You were mentioned", body: "You were mentioned in a comment in Fortleva." },
    sv: { subject: "Du omnämndes", body: "Du omnämndes i en kommentar i Fortleva." },
  },
  "work_item.commented": {
    en: { subject: "New comment", body: "A task you follow has a new comment." },
    sv: { subject: "Ny kommentar", body: "En uppgift du följer har en ny kommentar." },
  },
};

export function renderEmail(
  kind: NotificationKind,
  locale: string,
  params: Readonly<Record<string, unknown>> | null,
): { subject: string; text: string } {
  const copy = COPY[kind][locale === "sv" ? "sv" : "en"];
  const projectKey = typeof params?.["projectKey"] === "string" ? params["projectKey"] : null;
  const itemNumber = typeof params?.["itemNumber"] === "string" ? params["itemNumber"] : null;
  const link =
    projectKey && itemNumber
      ? new URL(`/projects/${projectKey}/backlog?item=${projectKey}-${itemNumber}`, appUrl)
      : new URL("/home", appUrl);
  return { subject: copy.subject, text: `${copy.body}\n\n${link.toString()}` };
}
