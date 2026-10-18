"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Pending } from "@/components/semantic/field";
import { Button } from "@/components/ui/button";

import { unscheduleUpdateAction } from "./actions";

/**
 * A SCHEDULED UPDATE'S ONE VERB (slice 135, founder decision C112 (a)): it is
 * locked until it goes out, so the way back to editing — or discarding — is
 * Unschedule, which makes it a plain draft again. Offered to a member who may
 * publish; the server asks the publish code either way. No confirm: nothing
 * is lost (the draft and its text stay), and scheduling again is two clicks.
 */
export function ScheduledActions({ projectKey, id }: { projectKey: string; id: string }) {
  const t = useTranslations("projects.updates.scheduled");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      data-testid="update-unschedule"
      onClick={() =>
        start(async () => {
          const r = await unscheduleUpdateAction({ projectKey, id }).catch(() => ({
            ok: false as const,
            message: t("failed"),
          }));
          if (!r.ok) {
            toast.error(r.message || t("failed"));
            // It may have gone out a moment ago: show what it is now (the
            // published post, with Retract while its window is open).
            router.refresh();
            return;
          }
          toast.success(t("unscheduled"));
          router.refresh();
        })
      }
    >
      {pending ? <Pending label={tCommon("loading")} /> : t("unschedule")}
    </Button>
  );
}
