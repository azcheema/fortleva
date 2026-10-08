"use client";

import { BellIcon, ClockIcon, InboxIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useLayoutEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { EmptyState, RowActions, type RowAction } from "@/components/semantic";
import { isGoSequencePending, useScopeKeys } from "@/components/shell/use-hotkeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RelativeTime } from "@/components/relative-time";
import { focusedKeyApplies, focusedKeyGuards, keyEventShape, ownsArrows, rovingStep } from "@/lib/keymap";
import { SNOOZE_PRESETS, snoozeUntil } from "@/lib/snooze";
import type { ActionResult } from "@/lib/server-actions";
import { cn } from "@/lib/utils";
import type { NotificationKind } from "@/notify/catalog";
import { staysInBucket } from "@/notify/inbox-buckets";
import type { InboxGroup } from "@/notify/inbox-groups";
import { GENERIC_COPY_KEY, KIND_MESSAGE_KEY } from "@/notify/kind-copy";
import { KIND_ICON } from "@/notify/kind-icon";
import type { InboxFilter } from "@/notify/inbox";
import type { NotificationReason } from "@/notify/reasons";
import { reminderLabel } from "@/notify/reminder-label";

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
 * The inbox list (UI.md §3.1). One row per notification under a day heading
 * (slice 104, C72 (c): Today · Yesterday · This week · Older — the
 * group is decided on the SERVER, in the member's zone, so both renders
 * agree), each with a quiet tag saying why it reached them (C72 (d)).
 *
 * THE VERBS. Snoozing has the row's own clock button (`RowActions`'
 * `primary` slot — the three presets, and "Bring it back now" on a snoozed
 * row); read/unread and archive/restore stay in `⋯` (§5.12).
 *
 * THE KEYS — the `inbox` scope (UI.md §6), the triage lane's shape: the
 * registry's `J` enters the list from anywhere no row holds focus, and
 * `J K ↑ ↓` · `Enter` · `E` · `U` · `S` are handled HERE, on the list,
 * because only the event target knows which row (`run: null` in the
 * registry, which still advertises them in `?`). The ROW is the focus
 * target, not its link, because some rows have none (a subject the member
 * may no longer open). `E` archives (restores, on Archived), `U` toggles
 * read, `S` opens the clock's menu (C72 (e)), `Enter` follows the row's
 * link.
 *
 * FOCUS NEVER FALLS TO `<body>`, where no suppression guard applies and
 * every single key acts. A verb that takes its row out of the tab being
 * shown (`staysInBucket`, the server's filters mirrored) names the row
 * focus moves to BEFORE the row goes — the next one, else the previous,
 * else the section itself, which is always rendered — and the layout effect
 * below puts it there once the row has gone, whether the verb came from a
 * key or from a menu. Nothing that can hold focus is ever disabled under it
 * ("Mark all" refuses a second press with a ref, not with `disabled`). The
 * day groups are keyed by NAME, so a group appearing or emptying above a
 * focused row never remounts it.
 *
 * Every verb is optimistic and runs in a transition, so a failure toasts
 * rather than looking like a revert (PLAN.md standing trap).
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
  /** A renewal reminder's band and count (`reminderLabel`); null otherwise. */
  reminder: { days: number; count: number | null } | null;
  /** Why it reached this member (C72 (d)); null on older rows. */
  reason: NotificationReason | null;
  /** The day heading it sits under (C72 (c)). */
  group: InboxGroup;
};

type Patch = {
  ids: readonly string[];
  /** The browser's instant — which tab a snoozed row belongs in depends on it. */
  at: number;
  read?: boolean;
  archived?: boolean;
  /** `undefined` leaves it; `null` wakes the row; an instant parks it. */
  snoozedTill?: string | null;
};

/** Where focus goes once these rows have left the list. */
type FocusAfter = { leaving: ReadonlySet<string>; to: string | null };

const patched = (r: InboxRowView, p: Patch): InboxRowView => ({
  ...r,
  read: p.read ?? r.read,
  archived: p.archived ?? r.archived,
  snoozedTill: p.snoozedTill === undefined ? r.snoozedTill : p.snoozedTill,
});

/**
 * The browser's clock, for a verb's patch. Read only from event handlers —
 * `run` and its callers; never during render, where the server's instant
 * (`serverNow`) is the one both renders share.
 */
const browserNow = (): number => Date.now();

/** The kind label with the reason tag is redundant: "A task was assigned to you · Assigned to you". */
const tagShown = (r: InboxRowView): r is InboxRowView & { reason: NotificationReason } =>
  r.reason !== null && !(r.kind === "work_item.assigned" && r.reason === "ASSIGNEE");

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
  const sectionRef = useRef<HTMLElement>(null);
  const focusAfter = useRef<FocusAfter | null>(null);
  const markingAll = useRef(false);
  // The ONE clock menu that is open, by row: `S` opens it from the keyboard.
  const [snoozeOpenFor, setSnoozeOpenFor] = useState<string | null>(null);

  // A patched row that no longer belongs in this tab LEAVES the optimistic
  // list (the server's next read agrees). Unpatched rows are never measured
  // against the clock here — a render-time `Date.now()` would disagree with
  // the server's render.
  const [shown, applyPatch] = useOptimistic(rows, (current: readonly InboxRowView[], p: Patch) => {
    const ids = new Set(p.ids);
    return current.flatMap((r) => {
      if (!ids.has(r.id)) return [r];
      const next = patched(r, p);
      return staysInBucket(filter, next, p.at) ? [next] : [];
    });
  });

  const order = shown.map((r) => r.id);
  const rowEl = (id: string): HTMLElement | null =>
    sectionRef.current?.querySelector<HTMLElement>(`[data-inbox-row][data-notification-id="${CSS.escape(id)}"]`) ?? null;

  const focusTarget = (to: string | null) => {
    const el = to ? rowEl(to) : null;
    (el ?? sectionRef.current)?.focus({ preventScroll: el === null });
  };

  // The rows have gone: put focus where the verb said, unless the member
  // has already taken it somewhere real (a click in the search field). The
  // removed row took focus to `<body>` with it, which is the case this is for
  // — and it holds for a verb chosen from a MENU too, in either order: if the
  // menu closes first, Radix focuses its trigger, which then leaves with the
  // row; if the row goes first, the menu goes with it, and Radix's late
  // attempt to focus a detached trigger does nothing.
  useLayoutEffect(() => {
    const want = focusAfter.current;
    if (!want || shown.some((r) => want.leaving.has(r.id))) return;
    focusAfter.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) focusTarget(want.to);
  });

  const run = (patch: Omit<Patch, "at">, fn: () => Promise<ActionResult<{ changed: number }>>) => {
    const p: Patch = { ...patch, at: browserNow() };
    const leaving = new Set(
      shown.filter((r) => p.ids.includes(r.id) && !staysInBucket(filter, patched(r, p), p.at)).map((r) => r.id),
    );
    if (leaving.size > 0) {
      // The first row after the last leaving one, else the last before the
      // first — the order the member was reading in.
      const idx = order.flatMap((id, i) => (leaving.has(id) ? [i] : []));
      const after = order.slice(Math.max(...idx) + 1).find((id) => !leaving.has(id));
      const before = order.slice(0, Math.min(...idx)).findLast((id) => !leaving.has(id));
      focusAfter.current = { leaving, to: after ?? before ?? null };
    }
    startTransition(async () => {
      applyPatch(p);
      const r = await fn().catch(() => null);
      if (r === null || !r.ok) {
        toast.error(r?.message ?? t("failed"));
      }
      // Refresh either way: on failure it is what puts the real row back
      // (an optimistic patch that is never reconciled is a lie).
      router.refresh();
    });
  };

  const toggleRead = (r: InboxRowView) =>
    r.read
      ? run({ ids: [r.id], read: false }, () => markUnreadAction([r.id]))
      : run({ ids: [r.id], read: true }, () => markReadAction([r.id]));

  const fileAway = (r: InboxRowView) =>
    r.archived
      ? run({ ids: [r.id], archived: false }, () => unarchiveAction([r.id]))
      : run({ ids: [r.id], archived: true, read: true }, () => archiveAction([r.id]));

  const snooze = (r: InboxRowView, preset: (typeof SNOOZE_PRESETS)[number]) => {
    // The instant comes from the BROWSER's clock: see src/lib/snooze.ts for
    // why the server cannot compute it.
    const till = snoozeUntil(preset, new Date()).toISOString();
    run({ ids: [r.id], snoozedTill: till, read: false }, () => snoozeAction([r.id], till));
  };

  const wake = (r: InboxRowView) => run({ ids: [r.id], snoozedTill: null }, () => unsnoozeAction([r.id]));

  const menuFor = (r: InboxRowView): RowAction[] => [
    r.read
      ? { key: "unread", label: t("row.markUnread"), onSelect: () => toggleRead(r) }
      : { key: "read", label: t("row.markRead"), onSelect: () => toggleRead(r) },
    r.archived
      ? { key: "unarchive", label: t("row.restore"), onSelect: () => fileAway(r) }
      : { key: "archive", label: t("row.archive"), onSelect: () => fileAway(r) },
  ];

  const markAll = () => {
    if (markingAll.current) return;
    markingAll.current = true;
    run({ ids: shown.map((r) => r.id), read: true }, async () => {
      try {
        return await markAllReadAction();
      } finally {
        markingAll.current = false;
      }
    });
  };

  // The registry's `J` is the ENTRY into the list: it acts only when NO
  // row holds focus (a row's own `J` is handled and prevented below,
  // before the dispatcher looks). Not a palette row — the palette's "On
  // this page" is for verbs.
  const enterList = () => {
    const active = document.activeElement;
    if (active instanceof Element && active.closest("[data-inbox-row]")) return;
    const first = order[0];
    if (first) rowEl(first)?.focus();
  };

  // `run: null` for the verbs: only the event target knows which row. On a
  // `run: null` binding `enabled` only decides what the `?` overlay
  // advertises — the handler below is the refusal (`triage-lane.tsx`).
  useScopeKeys("inbox", [
    { key: "j", label: t("keys.navigate"), enabled: true, run: enterList, hint: ["J", "or", "K"], palette: false },
    { key: "e", label: filter === "archived" ? t("keys.restore") : t("keys.archive"), enabled: true, run: null },
    { key: "u", label: t("keys.read"), enabled: true, run: null },
    { key: "s", label: t("keys.snooze"), enabled: filter !== "archived", run: null },
  ]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    // The key FIRST, before any DOM walk (the queue's rule).
    const step = rovingStep(e.key);
    const key = e.key.toLowerCase();
    const verb = key === "e" || key === "u" || key === "s" || key === "enter";
    if ((step === undefined && !verb) || !(e.target instanceof Element)) return;
    const el = e.target.closest<HTMLElement>("[data-inbox-row]");
    const id = el?.dataset["notificationId"];
    if (!el || !id) return;
    const shape = { ...keyEventShape(e), repeat: e.repeat };
    const goPending = isGoSequencePending();

    if (step !== undefined) {
      // Arrows are left to a control that owns them, and to Shift.
      if (step.arrow && (e.shiftKey || ownsArrows(e.target))) return;
      // Auto-repeat ALLOWED: a move is one row per event, so a held `J`
      // walks the list.
      if (!focusedKeyGuards(shape, goPending, { repeat: "allow" })) return;
      const at = order.indexOf(id);
      const to = at < 0 ? undefined : order[at + step.delta];
      if (!to) {
        // A LETTER at the end is still consumed — unprevented it would
        // reach the registry's `J` and jump to the top. An arrow is left
        // to the page, which scrolls.
        if (!step.arrow) e.preventDefault();
        return;
      }
      e.preventDefault();
      rowEl(to)?.focus();
      return;
    }

    // A held verb key is refused (`focusedKeyApplies`): `U` toggles, and a
    // held `E` would file the whole list away.
    if (!focusedKeyApplies(shape, key, goPending)) return;
    const row = shown.find((r) => r.id === id);
    if (!row) return;
    if (key === "enter") {
      // Only on the ROW itself: on the link, the clock or `⋯`, Enter is theirs.
      if (e.target !== el) return;
      const link = el.querySelector<HTMLAnchorElement>("[data-inbox-link]");
      if (!link) return;
      e.preventDefault();
      link.click();
      return;
    }
    if (key === "s" && row.archived) return;
    e.preventDefault();
    if (key === "e") fileAway(row);
    else if (key === "u") toggleRead(row);
    else setSnoozeOpenFor(row.id);
  };

  const nowMs = Date.parse(serverNow);

  // Rows arrive in the keyset's order, newest first, and the server has
  // clamped the groups monotone down the list — so a group is a RUN of rows.
  const runs: { group: InboxGroup; rows: InboxRowView[] }[] = [];
  for (const r of shown) {
    const last = runs.at(-1);
    if (last && last.group === r.group) last.rows.push(r);
    else runs.push({ group: r.group, rows: [r] });
  }

  return (
    // THE FALLBACK FOCUS TARGET — always rendered, empty state included, so
    // the last row leaving a tab has somewhere to send focus.
    <section ref={sectionRef} tabIndex={-1} aria-label={t("listLabel")} className="mt-4 rounded-card focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring" onKeyDown={onKeyDown}>
      {shown.length === 0 ? (
        <Empty filter={filter} paged={paged} />
      ) : (
        <>
          {filter === "unread" ? (
            <div className="mb-2 flex justify-end">
              <Button type="button" size="sm" variant="outline" data-testid="inbox-mark-all" onClick={markAll}>
                {t("markAllRead")}
              </Button>
            </div>
          ) : null}

          <div
            data-testid="inbox-list"
            aria-busy={pending || undefined}
            className="overflow-hidden rounded-card border border-border bg-card"
          >
            {runs.map(({ group, rows: inGroup }) => (
              <div
                // BY NAME, never by index: an index key remounted every later
                // group — and the focused row inside it, focus falling to
                // `<body>` — whenever an earlier group appeared or emptied
                // (code review). A name is unique within one render: the
                // server clamps the groups monotone and a verb only removes
                // rows. (A heading CAN repeat across a page boundary — on two
                // different pages.) A row whose group is renamed under it (a
                // refresh across midnight) still remounts — recorded.
                key={group}
                data-testid="inbox-group"
                data-group={group}
                className="border-b border-border last:border-b-0"
              >
                <h2 className="eyebrow px-3 pt-3 pb-1 text-muted-foreground">{t(`groups.${group}`)}</h2>
                <ul>
                  {inGroup.map((r) => {
                    const Icon = r.kind ? KIND_ICON[r.kind] : BellIcon;
                    // The key map and its catalogue coverage live in
                    // `@/notify/kind-copy` — a kind added without copy in BOTH
                    // languages fails `kind-copy.test.ts`, not a member's page.
                    const reminder = reminderLabel(r.kind, r.reminder);
                    const label =
                      reminder === null
                        ? t(`kind.${r.kind ? KIND_MESSAGE_KEY[r.kind] : GENERIC_COPY_KEY}`)
                        : reminder.key === "loginsExpiring"
                          ? t("reminder.loginsExpiring", { count: reminder.count, days: reminder.days })
                          : t(`reminder.${reminder.key}`, { days: reminder.days });
                    const snoozedAhead = r.snoozedTill !== null && Date.parse(r.snoozedTill) > nowMs;
                    // The row's accessible name, built from its VISIBLE parts —
                    // so the reason tag, the snooze and the time are spoken when
                    // J/K land on it, and cannot drift from what is drawn.
                    const part = (name: string) => `inbox-${r.id}-${name}`;
                    const labelledBy = [
                      part("label"),
                      tagShown(r) ? part("reason") : null,
                      part("subject"),
                      r.snoozedTill ? part("snoozed") : null,
                      part("time"),
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <li
                        key={r.id}
                        data-testid="inbox-row"
                        data-inbox-row=""
                        data-notification-id={r.id}
                        data-read={r.read ? "1" : "0"}
                        tabIndex={-1}
                        aria-labelledby={labelledBy}
                        aria-keyshortcuts={r.archived ? "J K E U" : "J K E U S"}
                        className="flex scroll-mt-16 scroll-mb-4 items-start gap-3 border-t border-border px-3 py-3 first:border-t-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                      >
                        {/* Unread is TWO channels, never colour alone: the dot and
                            the weight of the label below it (UI.md §9). */}
                        <span
                          aria-hidden="true"
                          className={cn("mt-2 size-2 shrink-0 rounded-full", r.read ? "bg-transparent" : "bg-primary")}
                        />
                        <Icon aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted-foreground" />

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <p id={part("label")} className={cn("text-sm", r.read ? "text-foreground" : "font-semibold")}>
                              {label}
                              {r.read ? null : <span className="sr-only"> — {t("unreadLabel")}</span>}
                            </p>
                            {tagShown(r) ? (
                              <Badge id={part("reason")} variant="outline" data-testid="inbox-reason" data-reason={r.reason}>
                                {t(`reason.${r.reason}`)}
                              </Badge>
                            ) : null}
                          </div>
                          {r.subject?.href ? (
                            <Link
                              id={part("subject")}
                              href={r.subject.href}
                              data-inbox-link=""
                              className="mt-0.5 block truncate text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                            >
                              {r.subject.title}
                            </Link>
                          ) : r.subject ? (
                            // Named, but its page would refuse this member (C34).
                            <p id={part("subject")} className="mt-0.5 truncate text-sm text-muted-foreground" title={r.subject.title}>
                              {r.subject.title}
                            </p>
                          ) : (
                            <p id={part("subject")} className="mt-0.5 text-sm text-muted-foreground">
                              {t("subjectUnavailable")}
                            </p>
                          )}
                          {r.snoozedTill ? (
                            <p id={part("snoozed")} className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
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
                          id={part("time")}
                          at={r.createdAt}
                          now={serverNow}
                          className="mt-0.5 shrink-0 text-xs whitespace-nowrap text-muted-foreground"
                        />
                        <RowActions
                          label={tCommon("actionsFor", { name: label })}
                          items={menuFor(r)}
                          primary={
                            r.archived ? null : (
                              <DropdownMenu
                                open={snoozeOpenFor === r.id}
                                onOpenChange={(open) => setSnoozeOpenFor(open ? r.id : null)}
                              >
                                {/* No tooltip: focus RETURNS to this trigger when
                                    the menu closes, and a tooltip opened by that
                                    return would eat the next Escape (AGENTS.md). */}
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={t("row.snoozeFor", { name: label })}
                                    aria-keyshortcuts="S"
                                    data-testid="inbox-snooze"
                                  >
                                    <ClockIcon />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {SNOOZE_PRESETS.map((preset) => (
                                    <DropdownMenuItem key={preset} onSelect={() => snooze(r, preset)}>
                                      {t(`row.snooze.${preset}`)}
                                    </DropdownMenuItem>
                                  ))}
                                  {snoozedAhead ? (
                                    <>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem onSelect={() => wake(r)}>{t("row.unsnooze")}</DropdownMenuItem>
                                    </>
                                  ) : null}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )
                          }
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>

          {nextHref ? (
            <div className="mt-3 flex justify-center">
              <Button asChild size="sm" variant="outline">
                <Link href={nextHref}>{t("nextPage")}</Link>
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
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
 * lie. "Next page" is rendered from the cursor the page was BUILT with, so
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
    );
  }
  if (filter === "all") {
    return (
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
    );
  }
  return (
    <EmptyState variant="filtered" title={t(`empty.${filter}.title`)} body={t(`empty.${filter}.body`)} action={all} />
  );
}
