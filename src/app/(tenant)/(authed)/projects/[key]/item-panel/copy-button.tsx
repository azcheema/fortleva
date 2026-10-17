"use client";

import { CopyIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { CopyTaskDialog, type CopySubject } from "@/components/work-view/copy-task-dialog";
import { panelSurfaceOf } from "@/lib/work-view";

/**
 * "Copy…" in the task panel's header (slice 129, founder decision C106): the
 * peek and the full page alike, beside "Open full page". Drawn for a member
 * who may create AND edit tasks (`ItemDetailCaps`); the dialog does the rest.
 * Focus comes back to this button when the dialog closes (`useFocusReturn`).
 */
export function CopyTaskButton({
  itemId,
  itemNumber,
  projectKey,
  surface,
  returnTo,
}: {
  itemId: string;
  itemNumber: number;
  projectKey: string;
  surface: "board" | "backlog" | "page";
  /** The panel's own URL — where a copy in the same project opens, as a peek. */
  returnTo: string;
}) {
  const t = useTranslations("projects.copy");
  const [subject, setSubject] = useState<CopySubject | null>(null);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        data-testid="item-copy"
        onClick={() => setSubject({ id: itemId, number: itemNumber, projectKey })}
      >
        <CopyIcon />
        {t("action")}
      </Button>
      <CopyTaskDialog
        subject={subject}
        actionSurface={panelSurfaceOf(surface)}
        landing={{ surface, returnTo }}
        onClosed={() => setSubject(null)}
      />
    </>
  );
}
