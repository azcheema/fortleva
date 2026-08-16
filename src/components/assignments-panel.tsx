"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/empty-state";
import { InlineConfirm } from "@/components/inline-confirm";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";

export type AssignmentRow = { memberId: string; name: string; email: string };
export type AssignableMember = { memberId: string; name: string; email: string };
export type AssignmentActionResult = { ok: boolean; message: string };

/**
 * Team panel shared by client and project pages: who is assigned, with
 * assign/unassign for holders of the manage_assignments permission.
 * Deliberately shows nothing but names (UI.md rule 14: no presence,
 * time or activity). Actions arrive as props so the same panel serves
 * both resources.
 */
export function AssignmentsPanel({
  assigned,
  members,
  canManage,
  assign,
  unassign,
  emptyTitle,
  emptyDescription,
}: {
  assigned: AssignmentRow[];
  members: AssignableMember[];
  canManage: boolean;
  assign: (memberId: string) => Promise<AssignmentActionResult>;
  unassign: (memberId: string) => Promise<AssignmentActionResult>;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const t = useTranslations("assignments");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [pick, setPick] = useState("");
  const assignedIds = new Set(assigned.map((a) => a.memberId));
  const candidates = members.filter((m) => !assignedIds.has(m.memberId));

  const run = (fn: () => Promise<AssignmentActionResult>) =>
    startTransition(async () => {
      const r = await fn();
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-3">
      {assigned.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {assigned.map((a) => (
            <li key={a.memberId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-sm">
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{a.name}</span>
                <span className="truncate text-xs text-muted-foreground">{a.email}</span>
              </span>
              {canManage ? (
                <InlineConfirm
                  label={t("unassign")}
                  question={t("unassignConfirm")}
                  pending={pending}
                  onConfirm={() => run(() => unassign(a.memberId))}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage && candidates.length > 0 ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pick) return;
            const chosen = pick;
            setPick("");
            run(() => assign(chosen));
          }}
        >
          <NativeSelect
            aria-label={t("pick")}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="w-64"
            disabled={pending}
          >
            <option value="">{t("pick")}</option>
            {candidates.map((m) => (
              <option key={m.memberId} value={m.memberId}>
                {m.name}
              </option>
            ))}
          </NativeSelect>
          <Button type="submit" size="sm" disabled={!pick || pending}>
            {t("assign")}
          </Button>
        </form>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("noPresence")}</p>
    </div>
  );
}
