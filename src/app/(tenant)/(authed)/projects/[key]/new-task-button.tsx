"use client";

import { PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { openQuickCreate } from "@/components/shell/quick-create";
import { Button } from "@/components/ui/button";

/**
 * A project page's "New task" (slice 129, founder decision C106 (c)): on
 * every tab, in the header's actions, it opens the shell's create dialog —
 * the same one `C` opens — which takes this project from the route. Drawn by
 * the layout only for a member who may create here.
 */
export function NewTaskButton() {
  const t = useTranslations("projects");
  return (
    <Button size="sm" onClick={openQuickCreate} data-testid="project-new-task">
      <PlusIcon />
      {t("newTask")}
    </Button>
  );
}
