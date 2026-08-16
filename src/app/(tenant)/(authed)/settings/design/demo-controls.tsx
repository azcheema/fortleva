"use client";

import { ChevronDownIcon, TrashIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const SHORTCUTS = ["1", "2"];

/**
 * The interactive half of the design preview: the four floating layers
 * (menu, select, tooltip, dialog) plus a toast, so their surfaces,
 * shadows and motion can be judged in the theme that is actually on.
 */
export function DemoControls() {
  const t = useTranslations("design.controls");
  const tFeedback = useTranslations("design.feedbackItems");

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" onClick={() => toast.success(tFeedback("toastMessage"))}>
        {tFeedback("toast")}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            {t("openMenu")}
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>{t("openMenu")}</DropdownMenuLabel>
          <DropdownMenuItem>
            {t("menuItem")}
            <DropdownMenuShortcut>{SHORTCUTS[0]}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            {t("menuItem")}
            <DropdownMenuShortcut>{SHORTCUTS[1]}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">
            <TrashIcon />
            {t("menuDestructive")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Select>
        <SelectTrigger className="w-44">
          <SelectValue placeholder={t("selectPlaceholder")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">{t("optionA")}</SelectItem>
          <SelectItem value="b">{t("optionB")}</SelectItem>
        </SelectContent>
      </Select>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost">{t("tooltipTrigger")}</Button>
        </TooltipTrigger>
        <TooltipContent>{t("tooltipText")}</TooltipContent>
      </Tooltip>

      <Dialog>
        <DialogTrigger asChild>
          <Button variant="secondary">{t("dialogTrigger")}</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dialogTitle")}</DialogTitle>
            <DialogDescription>{t("dialogBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </div>
  );
}
