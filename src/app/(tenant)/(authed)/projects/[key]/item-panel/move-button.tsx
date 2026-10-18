"use client";

import { FolderInputIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { MoveTaskDialog, type MoveSubject } from "@/components/work-view/move-task-dialog";
import { panelSurfaceOf, type PanelSurface } from "@/lib/work-view";

/**
 * "Move…" in the task panel's header (slice 131, founder decision C108): the
 * peek and the full page alike, beside "Copy…". Drawn for a member who may
 * create AND edit tasks (`ItemDetailCaps`) — a move takes a task out of one
 * project and creates it in another; the dialog says when the client has no
 * other project to go to, and the move asks everything again. Focus comes
 * back to this button when the dialog closes without moving
 * (`useFocusReturn`).
 */
export function MoveTaskButton({
  itemId,
  itemNumber,
  projectKey,
  surface,
  returnTo,
}: {
  itemId: string;
  itemNumber: number;
  projectKey: string;
  surface: PanelSurface;
  /** The panel's own URL — where the moved task opens on the Tasks page, as a peek. */
  returnTo: string;
}) {
  const t = useTranslations("projects.move");
  const [subject, setSubject] = useState<MoveSubject | null>(null);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        data-testid="item-move"
        onClick={() => setSubject({ id: itemId, number: itemNumber, projectKey })}
      >
        <FolderInputIcon />
        {t("action")}
      </Button>
      <MoveTaskDialog
        subject={subject}
        actionSurface={panelSurfaceOf(surface)}
        landing={{ surface, returnTo }}
        onClosed={() => setSubject(null)}
      />
    </>
  );
}
