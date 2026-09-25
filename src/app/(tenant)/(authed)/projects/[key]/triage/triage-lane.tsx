"use client";

import { CheckIcon, ClockIcon, CopyIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { isGoSequencePending, useScopeKeys } from "@/components/shell/use-hotkeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { focusedKeyApplies, focusedKeyGuards, keyEventShape, ownsArrows, rovingStep } from "@/lib/keymap";
import { formatDate } from "@/lib/format";

import { triageAction, triageDuplicateTargetsAction, type DuplicateTarget, type TriageActionInput } from "./actions";
import { TriageAnswer, type AnswerMode } from "./triage-answer";

/** One request in the lane — plain data, no `Date`s across the boundary. */
export type TriageRow = {
  id: string;
  /** `ACME-12` — the key the row shows. */
  key: string;
  number: number;
  title: string;
  body: string | null;
  reportedBy: string | null;
  /** ISO instant. */
  createdAt: string;
  /** True for a row that was snoozed and has come due — it is back, and says so. */
  wasSnoozed: boolean;
};

/**
 * THE LANE'S ROWS, ITS FOUR VERBS AND ITS KEYBOARD (UI.md §6, scope
 * `triage`: `A` · `D` · `U` · `S`).
 *
 * **THIS IS THE FIRST SURFACE TO MOUNT THE `triage` SCOPE**, which has
 * been declared and empty since 2W so that the slice filling it would be
 * a registration rather than a redesign. It is a PEER of `board` and
 * `backlog` in `SCOPE_ORDER`, and peers never mount together — which is
 * exactly why the lane is its own route: `S` cannot mean both "Move
 * to…" and "Snooze" on one page.
 *
 * THE FOUR VERBS ARE REGISTERED `run: null` AND HANDLED HERE, on the
 * list, for the board's and the backlog's reason: only a handler on the
 * event target knows WHICH row, and a window binding reading
 * `document.activeElement` would claim `A`, `D`, `U` and `S`
 * page-wide. The registry still advertises them in the `?` overlay,
 * which is what `run: null` is for.
 *
 * `J K` / `↑ ↓` rove between rows and the registry's bare `J` is the
 * ENTRY into the list from anywhere no row holds focus — the backlog
 * row's rule, verbatim, because a member who has learned it on one
 * surface must not have to learn it again here.
 *
 * **THE ROW IS THE FOCUS TARGET, not a link**, which is the backlog's
 * choice rather than `/home`'s: a queue row is one link and one button,
 * so its link can stand for it; a triage row holds FOUR buttons and no
 * link, so only a `tabIndex=-1` row can mean "the row". The verbs act
 * from anywhere inside it (`closest("[data-item-id]")`).
 *
 * AN ANSWERED ROW LEAVES THE LIST IMMEDIATELY and the server is asked
 * afterwards. That is not an optimistic write in the `useOptimistic`
 * sense — it is a local set of ids, because the alternative is the
 * standing trap: a transition around an action that revalidates stays
 * pending until the whole page has re-rendered (measured at over two
 * seconds on a task page), and every key guarded by that `isPending`
 * would be dead for the window. A refusal puts the row back and toasts,
 * so a failure can never look like a success.
 */
export function TriageLane({
  projectKey,
  projectId,
  entries,
  truncated,
  snoozedCount,
  canDecline,
}: {
  projectKey: string;
  projectId: string;
  entries: readonly TriageRow[];
  truncated: boolean;
  snoozedCount: number;
  /**
   * `work_item:triage_decline` — REQUIRED, never defaulted (the standing
   * trap). Employees may Accept and Snooze; ending a client's request
   * publishes the agency's words to them and is a delivery lead's call
   * (founder decision, 2026-09-22). The two verbs are HIDDEN without it
   * — §3.1's rule — and both the buttons and the `D`/`U` keys go with
   * them, because a key that silently does nothing is worse than a key
   * that is not advertised.
   */
  canDecline: boolean;
}) {
  const t = useTranslations("projects.triage");
  const tErrors = useTranslations("errors");
  const locale = useLocale();
  const router = useRouter();
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [answering, setAnswering] = useState<{ row: TriageRow; mode: AnswerMode } | null>(null);
  const [targets, setTargets] = useState<readonly DuplicateTarget[]>([]);
  const [targetsPending, setTargetsPending] = useState(false);
  // The reply lives HERE, not in the dialog: the dialog closes before
  // the server is asked and is keyed so every opening starts clean, so
  // a refusal would otherwise discard what the member wrote for a
  // client — the one text in this product they cannot simply retype
  // from memory.
  const [reason, setReason] = useState("");
  const listRef = useRef<HTMLUListElement>(null);

  const rows = entries.filter((e) => !answered.has(e.id));
  const order = rows.map((r) => r.id);
  const byId = new Map(rows.map((r) => [r.id, r]));

  // ANSWERED IDS ARE PRUNED WHENEVER THE SERVER'S LIST CHANGES. Without
  // this the set only ever grew: a row that legitimately came BACK to
  // triage — a colleague reopening a decline while this tab is open —
  // stayed invisible until a full navigation, because its id was still
  // in a set from ten minutes ago. Keyed on the server's ids, so it
  // settles in one pass and does not loop.
  const serverIds = entries.map((e) => e.id).join(",");
  const [seenIds, setSeenIds] = useState(serverIds);
  if (seenIds !== serverIds) {
    // ADJUSTED DURING RENDER, not in an effect — React's own pattern for
    // "state that depends on a prop", and the one ESLint allows here
    // (`set-state-in-effect` refuses the effect form outright). It
    // settles in one extra pass and never loops, because the guard
    // compares the same string it stores.
    setSeenIds(serverIds);
    const live = new Set(entries.map((e) => e.id));
    setAnswered((prev) => new Set([...prev].filter((id) => live.has(id))));
  }

  const rowEl = (id: string): HTMLElement | null =>
    listRef.current?.querySelector<HTMLElement>(
      `[data-triage-row][data-item-id="${CSS.escape(id)}"]`,
    ) ?? null;

  /**
   * ONE PLACE WHERE A VERB IS ACTUALLY SENT, whether it came from a
   * button, a key or the dialog — so the optimistic removal, the
   * rollback, the toast and the refresh cannot drift between three
   * call sites.
   */
  const send = async (row: TriageRow, input: TriageActionInput) => {
    if (busyId) return;
    setBusyId(row.id);
    // Out of the list first: the member has decided, and a row that
    // lingers invites a second press on a verb already in flight.
    setAnswered((prev) => new Set(prev).add(row.id));
    setAnswering(null);
    // **CAUGHT, AND THAT IS THE WHOLE POINT.** `runAction` returns a
    // typed refusal for an AuthzError or a DomainError and RETHROWS
    // everything else — and a server action also rejects on transport
    // failure (offline, a 500, a throw inside `revalidatePath`). Left
    // uncaught, the rejection skipped `setBusyId(null)` and the rollback
    // below: the row vanished with no toast, and every button and every
    // key on the whole lane stayed disabled until a manual reload. A
    // failure rendered as a success and then bricked the surface, which
    // is the strongest form of the standing trap. `backlog-table.tsx`
    // already does exactly this on its own move.
    const result = await triageAction(row.id, projectKey, input).catch(
      (): { ok: false; message: string } => ({ ok: false, message: tErrors("generic") }),
    );
    setBusyId(null);
    if (!result.ok) {
      // AN ACTION FAILURE MUST NEVER LOOK LIKE A REVERT (the standing
      // trap): the row comes back AND the member is told why.
      setAnswered((prev) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
      toast.error(result.message);
      return;
    }
    // "Your client can read your reply" only when the SERVER saw that they
    // can (`TriageOutcome.clientSees` — its five terms: the row shared, its
    // portal switch on, the project live, somebody at the client who
    // could sign in, and the workspace's portal module open). A request
    // is born shared, but any of those can have changed since. The item
    // panel's band was caught promising delivery unconditionally (C29a);
    // this toast was the same sentence, and C29b gave all four doors the
    // one answer.
    const shown = result.value.clientSees;
    toast.success(
      input.verb === "ACCEPT"
        ? t("accepted", { key: row.key })
        : input.verb === "DECLINE"
          ? t(shown ? "declined" : "declinedUnshared", { key: row.key })
          : input.verb === "DUPLICATE"
            ? t(shown ? "duplicated" : "duplicatedUnshared", { key: row.key })
            : t("snoozedToast", { key: row.key }),
    );
    // The reply has been published; the next one starts from nothing.
    setReason("");
    // **FOCUS MUST LAND SOMEWHERE**, and it will not on its own: the row
    // that held it was removed in the same tick, so `useFocusReturn`
    // finds a disconnected origin and skips the restore, leaving focus
    // on `<body>` — where no suppression guard applies and every single
    // key acts. The next row in the order the member was reading is the
    // honest destination; the list's end falls back to the previous row
    // and, failing that, to the list itself.
    const at = order.indexOf(row.id);
    const nextId = order[at + 1] ?? order[at - 1];
    if (nextId) rowEl(nextId)?.focus();
    else listRef.current?.focus();
    // The server list, the snoozed count and the board all move on a
    // triage; the action revalidated them, this is what re-reads them.
    router.refresh();
  };

  /**
   * Accept fires straight away; the other three need something from the
   * member, so they open the dialog. DUPLICATE also loads its picker's
   * rows at that moment — never with the page (`actions.ts` says why).
   */
  const begin = (row: TriageRow, verb: AnswerMode | "ACCEPT") => {
    if (busyId) return;
    if (!canDecline && (verb === "DECLINE" || verb === "DUPLICATE")) return;
    if (verb === "ACCEPT") {
      void send(row, { verb: "ACCEPT" });
      return;
    }
    // A different row, or a different verb, starts from a blank reply —
    // words written for one client must never be carried to another.
    if (answering && (answering.row.id !== row.id || answering.mode !== verb)) setReason("");
    setAnswering({ row, mode: verb });
    if (verb !== "DUPLICATE") return;
    setTargets([]);
    setTargetsPending(true);
    // …and the same on the picker's own read: an uncaught rejection left
    // `targetsPending` true for ever, so the dialog showed an empty list
    // with neither rows nor an empty state.
    void triageDuplicateTargetsAction(projectId, projectKey)
      .then((r) => {
        if (r.ok) setTargets(r.value);
        else toast.error(r.message);
      })
      .catch(() => toast.error(tErrors("generic")))
      .finally(() => setTargetsPending(false));
  };

  // The registry's `J` is the ENTRY into the list: it acts only when NO
  // row holds focus (a row's own `J` is handled and prevented before the
  // dispatcher looks). Not a palette row — the palette's "On this page"
  // is for verbs.
  const enterList = () => {
    const active = document.activeElement;
    if (active instanceof Element && active.closest("[data-triage-row]")) return;
    const first = order[0];
    if (first) rowEl(first)?.focus();
  };

  // `run: null` for the four verbs: only the event target knows which
  // row.
  //
  // `enabled: false` while a verb is in flight HIDES THE OVERLAY ROW AND
  // NOTHING MORE — it does not swallow the key, and the first version of
  // this comment claimed it did. `decide()` skips a `run: null` binding
  // BEFORE it reads `enabled` (`keymap.ts`), which that field's own
  // docblock states outright. So mid-flight these four fall through to
  // the `global` scope, where none of `a`/`d`/`u`/`s` is bound today.
  // The actual refusal is the `busyId !== null` check in the handler
  // below; this flag only stops the `?` overlay advertising a verb that
  // is momentarily inert.
  useScopeKeys("triage", [
    { key: "j", label: t("keys.navigate"), enabled: true, run: enterList, hint: ["J", "or", "K"], palette: false },
    { key: "a", label: t("keys.ACCEPT"), enabled: busyId === null, run: null },
    // Hidden from the `?` overlay and the palette for a member who
    // cannot use them. The handler refuses them too (below) — this flag
    // only decides what is ADVERTISED.
    { key: "d", label: t("keys.DECLINE"), enabled: canDecline && busyId === null, run: null },
    { key: "u", label: t("keys.DUPLICATE"), enabled: canDecline && busyId === null, run: null },
    { key: "s", label: t("keys.SNOOZE"), enabled: busyId === null, run: null },
  ]);

  const VERB_KEYS: Record<string, AnswerMode | "ACCEPT"> = {
    a: "ACCEPT",
    d: "DECLINE",
    u: "DUPLICATE",
    s: "SNOOZE",
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    // The key FIRST, before any DOM walk (the queue's rule).
    const step = rovingStep(e.key);
    const verb = VERB_KEYS[e.key.toLowerCase()];
    if ((step === undefined && !verb) || !(e.target instanceof Element)) return;
    const el = e.target.closest<HTMLElement>("[data-triage-row]");
    const id = el?.dataset["itemId"];
    if (!el || !id) return;
    const shape = { ...keyEventShape(e), repeat: e.repeat };
    const goPending = isGoSequencePending();

    if (step !== undefined) {
      // Arrows are left to a control that owns them, and to Shift.
      if (step.arrow && (e.shiftKey || ownsArrows(e.target))) return;
      // **THE GUARD THIS BRANCH WAS MISSING**, and both reference
      // surfaces call it (`queue-rows.tsx`, `backlog-table.tsx`).
      // Without it two things went wrong, and the second is the bad one:
      // a chord (`Ctrl+J` — Chrome's Downloads) moved the focus and was
      // preventDefaulted; and an ARMED `G` was consumed here and LEFT
      // ARMED, because this handler runs before the dispatcher and
      // `preventDefault` makes `decide()` bail at its first guard
      // without ever calling `clearPending()`. `G` then `J` therefore
      // ate the NEXT key too — the member's `A` did nothing at all, in
      // silence. Auto-repeat stays allowed: a move is one row per event,
      // so a held `J` walks the list, which is the board's rule.
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

    // A held verb key is refused (`focusedKeyApplies`), because these
    // four are decisions and auto-repeat would answer a whole lane.
    if (!verb || busyId !== null || !focusedKeyApplies(shape, e.key.toLowerCase(), goPending)) return;
    // The two publishing verbs need the second permission. Left
    // UNPREVENTED so the key falls through rather than dying silently —
    // there is nothing lower that claims `d` or `u` today, but a key
    // this surface has decided not to own is not this surface's to eat.
    if (!canDecline && (verb === "DECLINE" || verb === "DUPLICATE")) return;
    e.preventDefault();
    const row = byId.get(id);
    if (row) begin(row, verb);
  };

  return (
    <>
      {truncated ? (
        <p data-testid="triage-truncated" className="border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
          {/* `entries`, not `rows`: the cap cut the SERVER's list, and
              counting the client-filtered one turned "showing the first
              100" into "showing the first 97" after three answers. */}
          {t("truncated", { count: entries.length })}
        </p>
      ) : null}
      <ul
        ref={listRef}
        data-testid="triage-lane"
        onKeyDown={onKeyDown}
        aria-busy={busyId !== null || undefined}
      >
        {rows.map((row) => (
          <li
            key={row.id}
            data-triage-row=""
            data-testid="triage-row"
            data-item-id={row.id}
            tabIndex={-1}
            aria-label={t("row", { key: row.key, title: row.title })}
            aria-keyshortcuts={canDecline ? "J K A D U S" : "J K A S"}
            className="flex scroll-mt-16 scroll-mb-4 flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0 hover:bg-accent focus:outline-2 focus:-outline-offset-2 focus:outline-ring"
          >
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="num-id shrink-0 font-mono text-xs text-muted-foreground">{row.key}</span>
              <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{row.title}</span>
              {row.wasSnoozed ? <Badge variant="outline">{t("wasSnoozed")}</Badge> : null}
            </div>
            {row.body ? (
              // The client's own words, as TEXT. `createRequest` stores a
              // portal submission in `descriptionText` and leaves
              // `description` NULL precisely so nobody has to trust it as
              // markup; `line-clamp` keeps a long one from pushing the
              // verbs off the first screen.
              <p className="line-clamp-3 text-sm whitespace-pre-wrap text-muted-foreground">{row.body}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{row.reportedBy ? t("reportedBy", { name: row.reportedBy }) : t("reportedByUnknown")}</span>
              <span>
                {t("askedOn", {
                  date: formatDate(locale, new Date(row.createdAt), {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  }),
                })}
              </span>
            </div>
            {/* DISABLED ONLY ON THE ROW THAT IS ACTING. Disabling every
                row's buttons while one verb is in flight drops focus to
                `<body>` the moment the focused button goes `disabled` —
                `queue-rows.tsx` records that exact rule — and it is not
                needed: `send` refuses a second verb on its own
                (`if (busyId) return`), and the acting row is leaving the
                list anyway. */}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busyId === row.id} onClick={() => begin(row, "ACCEPT")}>
                <CheckIcon />
                {t("verbs.ACCEPT")}
              </Button>
              {canDecline ? (
                <>
                  <Button size="sm" variant="outline" disabled={busyId === row.id} onClick={() => begin(row, "DECLINE")}>
                    <XIcon />
                    {t("verbs.DECLINE")}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busyId === row.id} onClick={() => begin(row, "DUPLICATE")}>
                    <CopyIcon />
                    {t("verbs.DUPLICATE")}
                  </Button>
                </>
              ) : null}
              <Button size="sm" variant="outline" disabled={busyId === row.id} onClick={() => begin(row, "SNOOZE")}>
                <ClockIcon />
                {t("verbs.SNOOZE")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {snoozedCount > 0 ? (
        <p data-testid="triage-snoozed" className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          {t("snoozed", { count: snoozedCount })}
        </p>
      ) : null}
      {/* Keyed on the row AND the mode, so every opening starts from an
          empty reason and nothing chosen — a dialog that reopens on last
          week's half-typed reply is a dialog nobody trusts, and on this
          surface that text goes to a client. */}
      {answering ? (
        <TriageAnswer
          key={`${answering.row.id}:${answering.mode}`}
          mode={answering.mode}
          itemKey={answering.row.key}
          itemTitle={answering.row.title}
          reason={reason}
          onReasonChange={setReason}
          targets={targets}
          targetsPending={targetsPending}
          busy={busyId !== null}
          onCancel={() => setAnswering(null)}
          onSubmit={(input) => void send(answering.row, input)}
        />
      ) : null}
    </>
  );
}
