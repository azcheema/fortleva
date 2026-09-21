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

import { useRun } from "../use-run";
import { enterViewAsAction } from "@/app/(tenant)/view-as/actions";

/**
 * THE DOOR INTO VIEW-AS-CONTACT, and the only one (Phase 3 slice 5).
 *
 * It sits on Project → Portal beside the static preview, because the
 * two answer different questions and the difference is worth a second
 * control rather than a replacement. The panel answers "what does this
 * project publish?" at a glance, for the contact whose profile sees the
 * most. This answers "what does *Anna* actually get?" — the whole
 * client, navigable, in her language.
 *
 * A BUTTON AND NOT A LINK. Entering is the act
 * `project.viewed_as_contact` records, and Next prefetches `<Link>`s in
 * production, so a link would write an audit row when the mouse crossed
 * it. `useRun` toasts the typed result, which is the standing trap this
 * file would otherwise walk into: the refusals are real — the contact
 * suspended, the role narrowed, the client unassigned between this
 * render and the click — and a silent bounce would read as a failure
 * that reverted.
 *
 * THE NAVIGATION IS THE CALLER'S, not the action's, for the same
 * reason. A server action that redirected could not also report a
 * refusal, and the refusal is the case that needs words.
 *
 * IT IS RENDERED ONLY WHEN THERE IS SOMEBODY TO BE. The page passes a
 * contact or does not render this at all — a "View as client" button on
 * a client with no contact who can sign in is a button whose only
 * outcome is an error, and §5.8 puts the verb for that state on the
 * audience card instead ("Manage contacts").
 */
export function ViewAsButton({
  contactId,
  projectId,
  contactName,
}: {
  contactId: string;
  projectId: string;
  contactName: string;
}) {
  const t = useTranslations("viewAs");
  const router = useRouter();
  const { pending, run } = useRun();

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      // A flex item is stretched on the cross axis and blockified, so
      // `inline-flex` does not save it: without this the button spans
      // the whole two-thirds column. The two sibling buttons on the same
      // page carry it for the same reason (code review).
      className="self-start"
      disabled={pending}
      onClick={() =>
        run(
          () => enterViewAsAction(contactId, projectId),
          () => router.push(VIEW_AS_PREFIX),
        )
      }
    >
      <EyeIcon aria-hidden="true" />
      {t("enter", { name: contactName })}
    </Button>
  );
}
