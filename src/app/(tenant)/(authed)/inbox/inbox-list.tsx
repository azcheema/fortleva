"use client";

import { BellIcon, ClockIcon, InboxIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";

import { EmptyState, RowActions, type RowAction } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/relative-time";
import { SNOOZE_PRESETS, snoozeUntil } from "@/lib/snooze";
import type { ActionResult } from "@/lib/server-actions";
import { cn } from "@/lib/utils";
import type { NotificationKind } from "@/notify/catalog";
import { GENERIC_COPY_KEY, KIND_MESSAGE_KEY } from "@/notify/kind-copy";
import { KIND_ICON } from "@/notify/kind-icon";
import type { InboxFilter } from "@/notify/inbox";

import {
  archiveAction,
  markAllReadAction,
  markReadAction,
  markUnreadAction,
  snoozeAction,
  unarchiveAction,
  unsnoozeAction,
} from "./actions";

/**
 * The inbox list (UI.md §3.1). One row per notification, its verbs in
 * the row's `⋯` menu (§5.12 — the row's weight belongs in a menu, not
 * in a strip of buttons repeated down the page).
 *
 * NO SINGLE-KEY BINDINGS, and the reason is the same one the selection
 * bar records: UI.md §6 names an `inbox` scope (`J K` · `E` · `U` ·
 * `S`), but a single key owes rule 7 a ⌘K entry and a row in the `?`
 * overlay, and neither exists yet — `command-palette.tsx` has a closed
 * set of global actions with no registry for page-contextual ones, and
 * the overlay is not scope-aware. `G I` DOES ship, because it is a
 * nav-registry `goKey` and both surfaces derive their rows from that
 * registry. The rest arrives with `react-hotkeys-hook` and the scopes.
 *
 * Every verb is optimistic and runs in a transition, so a failure
 * toasts rather than looking like a revert (PLAN.md standing trap).
 */

export type InboxRowView = {
  id: string;
  kind: NotificationKind | null;
  /** ISO instant — Dates do not survive the server/client boundary. */
  createdAt: string;
  read: boolean;
  archived: boolean;
  snoozedTill: string | null;
  /** Null when the member may no longer see what this is about. */
  subject: { title: string; href: string | null } | null;
};

type Patch = { ids: readonly string[]; read?: boolean; archived?: boolean; snoozed?: boolean };

export function InboxList({
  filter,
  rows,
  nextHref,
  paged,
  serverNow,
}: {
  filter: InboxFilter;
  rows: readonly InboxRowView[];
  /** The next keyset page, or null at the end of the bucket. */
  nextHref: string | null;
  /** True when a cursor was in the URL — this is not the first page. */
  paged: boolean;
  /** The instant the page rendered — the reference every relative time
   * on this page is measured from, so server and client agree. */
  serverNow: string;
}) {
  const t = useTranslations("inbox");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [shown, applyPatch] = useOptimistic(rows, (current: readonly InboxRowView[], p: Patch) => {
    const ids = new Set(p.ids);
    return current.map((r) =>
      ids.has(r.id)
        ? {
            ...r,
            read: p.read ?? r.read,
            archived: p.archived ?? r.archived,
            snoozedTill: p.snoozed === false ? null : r.snoozedTill,
          }
        : r,
    );
  });

  const run = (patch: Patch, fn: () => Promise<ActionResult<{ changed: number }>>) => {
    startTransition(async () => {
      applyPatch(patch);
      const r = await fn().catch(() => null);
      if (r === null || !r.ok) {
        toast.error(r?.message ?? t("failed"));
      }
      // Refresh either way: on failure it is what puts the real row back
      // (an optimistic patch that is never reconciled is a lie).
      router.refresh();
    });
  };

  const menuFor = (r: InboxRowView): RowAction[] => {
    const items: RowAction[] = [];
    items.push(
      r.read
        ? {
            key: "unread",
            label: t("row.markUnread"),
            onSelect: () => run({ ids: [r.id], read: false }, () => markUnreadAction([r.id])),
          }
        : {
            key: "read",
            label: t("row.markRead"),
            onSelect: () => run({ ids: [r.id], read: true }, () => markReadAction([r.id])),
          },
    );
    if (r.snoozedTill) {
      items.push({
        key: "unsnooze",
        label: t("row.unsnooze"),
        onSelect: () => run({ ids: [r.id], snoozed: false }, () => unsnoozeAction([r.id])),
      });
    } else if (!r.archived) {
      for (const preset of SNOOZE_PRESETS) {
        items.push({
          key: `snooze-${preset}`,
          label: t(`row.snooze.${preset}`),
          onSelect: () =>
            run({ ids: [r.id], read: false }, () =>
              // The instant comes from the BROWSER's clock: see
              // src/lib/snooze.ts for why the server cannot compute it.
              snoozeAction([r.id], snoozeUntil(preset, new Date()).toISOString()),
            ),
        });
      }
    }
    items.push(
      r.archived
        ? {
            key: "unarchive",
            label: t("row.restore"),
            onSelect: () => run({ ids: [r.id], archived: false }, () => unarchiveAction([r.id])),
          }
        : {
            key: "archive",
            label: t("row.archive"),
            onSelect: () =>
              run({ ids: [r.id], archived: true, read: true }, () => archiveAction([r.id])),
          },
    );
    return items;
  };

  if (shown.length === 0) return <Empty filter={filter} paged={paged} />;

  return (
    <div className="mt-4">
      {filter === "unread" ? (
        <div className="mb-2 flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            data-testid="inbox-mark-all"
            onClick={() =>
              startTransition(async () => {
                applyPatch({ ids: shown.map((r) => r.id), read: true });
                const r = await markAllReadAction().catch(() => null);
                if (r === null || !r.ok) toast.error(r?.message ?? t("failed"));
                router.refresh();
              })
            }
          >
            {t("markAllRead")}
          </Button>
        </div>
      ) : null}

      <ul
        data-testid="inbox-list"
        aria-busy={pending || undefined}
        className="overflow-hidden rounded-card border border-border bg-card"
      >
        {shown.map((r) => {
          const Icon = r.kind ? KIND_ICON[r.kind] : BellIcon;
          // The key map and its catalogue coverage live in
          // `@/notify/kind-copy` — a kind added without copy in BOTH
          // languages fails `kind-copy.test.ts`, not a member's page.
          const label = t(
            `kind.${r.kind ? KIND_MESSAGE_KEY[r.kind] : GENERIC_COPY_KEY}`,
          );
          return (
            <li
              key={r.id}
              data-testid="inbox-row"
              data-notification-id={r.id}
              data-read={r.read ? "1" : "0"}
              className="flex items-start gap-3 border-b border-border px-3 py-3 last:border-b-0"
            >
              {/* Unread is TWO channels, never colour alone: the dot and
                  the weight of the label below it (UI.md §9). */}
              <span
                aria-hidden="true"
                className={cn(
                  "mt-2 size-2 shrink-0 rounded-full",
                  r.read ? "bg-transparent" : "bg-primary",
                )}
              />
              <Icon aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted-foreground" />

              <div className="min-w-0 flex-1">
                <p className={cn("text-sm", r.read ? "text-foreground" : "font-semibold")}>
                  {label}
                  {r.read ? null : <span className="sr-only"> — {t("unreadLabel")}</span>}
                </p>
                {r.subject?.href ? (
                  <Link
                    href={r.subject.href}
                    className="mt-0.5 block truncate text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {r.subject.title}
                  </Link>
                ) : r.subject ? (
                  // Named, but its page would refuse this member (C34).
                  <p className="mt-0.5 truncate text-sm text-muted-foreground" title={r.subject.title}>
                    {r.subject.title}
                  </p>
                ) : (
                  <p className="mt-0.5 text-sm text-muted-foreground">{t("subjectUnavailable")}</p>
                )}
                {r.snoozedTill ? (
                  <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ClockIcon aria-hidden="true" className="size-3.5" />
                    {t("snoozedUntil", {
                      date: format.dateTime(new Date(r.snoozedTill), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                    })}
                  </p>
                ) : null}
              </div>

              <RelativeTime
                at={r.createdAt}
                now={serverNow}
                className="mt-0.5 shrink-0 text-xs whitespace-nowrap text-muted-foreground"
              />
              <RowActions label={tCommon("actionsFor", { name: label })} items={menuFor(r)} />
            </li>
          );
        })}
      </ul>

      {nextHref ? (
        <div className="mt-3 flex justify-center">
          <Button asChild size="sm" variant="outline">
            <Link href={nextHref}>{t("older")}</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Four buckets, four honest empty states. Only the whole inbox being
 * empty is `variant="empty"` — the other three are a bucket with
 * nothing in it, which is `filtered`, and whose verb is the bucket next
 * to it (UI.md §5.8: nothing-yet, no-matches and not-for-you are three
 * different states with three different next actions).
 *
 * A PAGE PAST THE END IS A FIFTH STATE, and it is the one that would
 * lie. "Older" is rendered from the cursor the page was BUILT with, so
 * anything that happens between that render and the click can empty it:
 * marking the rest read in another tab, an archive, a snooze — and,
 * less often, a cursor URL that was bookmarked or shared and whose rows
 * have since been filed. It is a plain race, not an exotic one.
 * Rendering "No notifications yet" there tells a member with a full
 * inbox that they have none. The verb is to go back to the newest.
 */
function Empty({ filter, paged }: { filter: InboxFilter; paged: boolean }) {
  const t = useTranslations("inbox");
  const all = (
    <Button asChild size="sm" variant="outline">
      <Link href="/inbox?filter=all">{t("empty.seeAll")}</Link>
    </Button>
  );
  if (paged) {
    const first = filter === "unread" ? "/inbox" : `/inbox?filter=${filter}`;
    return (
      <div className="mt-4">
        <EmptyState
          variant="filtered"
          title={t("empty.pastEnd.title")}
          body={t("empty.pastEnd.body")}
          action={
            <Button asChild size="sm" variant="outline">
              <Link href={first}>{t("empty.pastEnd.action")}</Link>
            </Button>
          }
        />
      </div>
    );
  }
  if (filter === "all") {
    return (
      <div className="mt-4">
        <EmptyState
          variant="empty"
          icon={InboxIcon}
          title={t("empty.all.title")}
          body={t("empty.all.body")}
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/home">{t("empty.all.action")}</Link>
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <div className="mt-4">
      <EmptyState
        variant="filtered"
        title={t(`empty.${filter}.title`)}
        body={t(`empty.${filter}.body`)}
        action={all}
      />
    </div>
  );
}
