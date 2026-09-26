"use client";

import { EyeIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
// `@/config/view-as`, NEVER `@/config`: this is a client component, and
// the index module parses `process.env` and derives a secret at module
// scope, all of which Turbopack keeps as a side effect in the browser
// chunk (code review, measured in `.next/static/chunks`).
import { VIEW_AS_PREFIX } from "@/config/view-as";

import { useRun } from "@/components/use-run";
import { enterViewAsAction } from "@/app/(tenant)/view-as/actions";

/**
 * THE DOORS INTO VIEW-AS-CONTACT, and the only ones (Phase 3 slice 5;
 * the second door since the Client Timeline slice).
 *
 * They sit on Project → Portal beside the static preview, because the
 * panel and the buttons answer different questions and the difference
 * is worth a control rather than a replacement. The panel answers "what
 * does this project publish?" at a glance, for the contact whose profile
 * sees the most. These answer "what does *Anna* actually get?" — the
 * whole client, navigable, in her language: her home, or her one-screen
 * page for THIS project (`/view-as/projects/[key]`).
 *
 * BUTTONS AND NOT LINKS. Entering is the act `project.viewed_as_contact`
 * records, and Next prefetches `<Link>`s in production, so a link would
 * write an audit row when the mouse crossed it. `useRun` toasts the
 * typed result, which is the standing trap this file would otherwise
 * walk into: the refusals are real — the contact suspended, the role
 * narrowed, the client unassigned between this render and the click —
 * and a silent bounce would read as a failure that reverted.
 *
 * ONE `useRun` FOR BOTH DOORS, so a click on either disables the other
 * while the action is in flight: two independent buttons let a member
 * enter the mode twice in one second and write two audit rows for one
 * act, with the later `router.push` deciding where they landed (code
 * review). The destination is built HERE, client-side, from a key the
 * page already rendered — never a parameter the action redirects to,
 * for the reason `actions.ts` gives about return paths.
 *
 * THE NAVIGATION IS THE CALLER'S, not the action's, for the same
 * reason. A server action that redirected could not also report a
 * refusal, and the refusal is the case that needs words.
 *
 * RENDERED ONLY WHEN THERE IS SOMEBODY TO BE. The page passes a contact
 * or does not render this at all — a "View as client" button on a
 * client with no contact who can sign in is a button whose only outcome
 * is an error, and §5.8 puts the verb for that state on the audience
 * card instead ("Manage contacts").
 */
export function ViewAsButtons({
  contactId,
  projectId,
  projectKey,
  contactName,
}: {
  contactId: string;
  projectId: string;
  projectKey: string;
  contactName: string;
}) {
  const t = useTranslations("viewAs");
  const router = useRouter();
  const { pending, run } = useRun();
  const enter = (to: string) =>
    run(
      () => enterViewAsAction(contactId, projectId),
      () => router.push(to),
    );

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        // A flex item is stretched on the cross axis and blockified, so
        // `inline-flex` does not save it: without this the button spans
        // the whole two-thirds column. The sibling buttons on the same
        // page carry it for the same reason (code review).
        className="self-start"
        disabled={pending}
        onClick={() => enter(VIEW_AS_PREFIX)}
      >
        <EyeIcon aria-hidden="true" />
        {t("enter", { name: contactName })}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={pending}
        onClick={() => enter(`${VIEW_AS_PREFIX}/projects/${projectKey}`)}
      >
        <EyeIcon aria-hidden="true" />
        {t("enterProject", { name: contactName })}
      </Button>
    </div>
  );
}
