import { EyeIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Button } from "@/components/ui/button";
import { resolveMemberLocale } from "@/i18n/resolve";
import { TONE_CALLOUT, TONE_LINE } from "@/lib/tones";
import { cn } from "@/lib/utils";

import { exitViewAsAction } from "./actions";

/**
 * THE RED BANNER — one of the four things SECURITY.md §5.1's vector
 * table requires of View-as-Contact, and the only one a person can see.
 *
 * WHAT IT IS FOR. Everything below it is a faithful rendering of
 * somebody else's screen, in somebody else's language, and the member
 * is one browser tab away from their own application which looks
 * nothing like it. The hazard is not that they are confused for a
 * second; it is that they read a client's portal, see three tasks, and
 * conclude the project has three tasks. `danger` rather than `caution`
 * for exactly that reason: caution is the tone the product uses for
 * "this will be visible to a client", which is a statement ABOUT the
 * data, and this is a statement about the READER.
 *
 * THE COPY IS UI.md §11's, quoted rather than invented: *"Viewing as
 * <contact> — you see exactly what they see"*. The second half is the
 * part that earns the banner, and it is a claim the slice has to be
 * able to defend — which is what `e2e/view-as.spec.ts` compares byte
 * for byte against a real contact session.
 *
 * IT SITS OUTSIDE `data-portal-surface`, which is the boundary of that
 * comparison. That is not a layout detail: the banner is the one thing
 * on this route no contact ever receives, so if it were inside the
 * compared region byte-identity would be impossible by construction and
 * the test would have to be weakened to a subset match — the exact
 * dilution the pins exist to prevent.
 *
 * NOT STICKY, deliberately. A fixed bar would overlay a portal page
 * whose own scroll container it does not own, and the portal frame is
 * `min-h-svh` — a sticky banner above it would hide content at the
 * bottom of a phone screen with nothing able to scroll it back. It
 * leads the document instead, which also means the first thing a screen
 * reader reaches is the sentence explaining what the page is.
 *
 * EXIT IS A FORM AND NOT A LINK, for the reason the workspace picker is
 * (`dashboard/actions.ts`): Next PREFETCHES `<Link>`s in production, so
 * a GET that left the mode would fire on hover. Here that would drop a
 * member out of View-as for passing the mouse over the button.
 *
 * **IT RENDERS IN THE MEMBER'S LANGUAGE, NOT THE CONTACT'S**, and it is
 * the only thing on this route that does. `resolveLocale` pins the whole
 * `/view-as` request to the contact's language, which is correct for the
 * surface below — that is what byte-identity means. But these two
 * strings are the warning that you are looking at somebody else's screen
 * and the control that gets you out; rendering them in a language chosen
 * for the CLIENT would hand a Swedish-reading member an English warning
 * and an English exit (code review, 2026-09-21). `getTranslations({
 * locale })` against `resolveMemberLocale()` is what separates them, and
 * `src/i18n/request.ts` had to start honouring an explicit locale for it
 * to work at all.
 */
export async function ViewAsBanner({ name }: { name: string }) {
  const t = await getTranslations({ locale: await resolveMemberLocale(), namespace: "viewAs" });
  return (
    <div
      data-slot="view-as-banner"
      // `role="status"` and not `alert`: nothing has gone wrong, and an
      // alert interrupts a screen reader mid-sentence on every render of
      // every page inside the mode.
      role="status"
      className={cn("border-b px-4 py-2.5 md:px-6", TONE_CALLOUT.danger)}
    >
      <div className="mx-auto flex w-full max-w-(--content-default) flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <EyeIcon aria-hidden="true" className={cn("size-4 shrink-0", TONE_LINE.danger)} />
          <span className="min-w-0">{t("banner", { name })}</span>
        </p>
        <form action={exitViewAsAction}>
          <Button type="submit" variant="outline" size="sm">
            {t("exit")}
          </Button>
        </form>
      </div>
    </div>
  );
}
