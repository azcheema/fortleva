type AutoFocusHandler = (event: Event) => void;

/**
 * A Radix dialog's content playing its EXIT animation. Radix keeps it
 * mounted, `data-state="closed"`, until the animation ends, and the
 * element inside it that had focus keeps focus until then. Reduced motion
 * shortens that animation to 1ms and does not remove it, so the window
 * still exists there. Popover content is `role="dialog"` too, and a
 * closing one matches but is not in `origins`: a dialog opened inside
 * that popover's exit window (a picker's Escape, then ⌘K, within one
 * `--dur-instant`) records the popover's dying input and returns focus
 * nowhere, because the new dialog's trap also bounces Radix's own return
 * to the popover's trigger. A recorded residue (PLAN §0).
 */
const CLOSING_DIALOG = '[role="dialog"][data-state="closed"]';

/**
 * Every dialog opened through this hook: its FocusScope container → the
 * element focus goes back to when it closes. Radix dispatches BOTH
 * autofocus events on that container (`react-focus-scope`), so
 * `event.target` is the key. The container is also the element that
 * carries `role="dialog"` and `data-state`, so `closest()` from anything
 * inside it finds the entry.
 *
 * A WeakMap, so however a dialog is unmounted, its entry cannot outlive
 * it. `onCloseAutoFocus` deletes it as well, before any caller code runs.
 *
 * Every write to module state happens in the plain functions below and
 * never in the hook's closures.
 */
const origins = new WeakMap<Element, HTMLElement | null>();

/** True only while `restore` is inside its `focus()` call. */
let returning = false;

/**
 * Where a dialog opened from `from` should return focus.
 *
 * If `from` sits inside a CLOSING dialog of this hook's, the answer is
 * that dialog's origin, not `from`. The palette's "Keyboard shortcuts"
 * row closes the palette and opens the `?` overlay in one batch, so the
 * overlay mounts while the palette is still playing its exit and still
 * holds focus. Recording the palette's input meant returning to a node
 * that was gone by then, and focus fell to <body> over the picker the
 * palette had been opened from.
 *
 * Only a CLOSING one. A dialog opened over one that stays open (⌘K over
 * the open `?` overlay) records the element inside it, so focus goes
 * back INTO the dialog still open, not behind it.
 */
function originFor(from: Element | null): HTMLElement | null {
  const leaving = from?.closest(CLOSING_DIALOG);
  if (leaving && origins.has(leaving)) return origins.get(leaving) ?? null;
  return from instanceof HTMLElement && from !== document.body ? from : null;
}

function capture(event: Event): void {
  if (event.target instanceof Element) {
    origins.set(event.target, originFor(document.activeElement));
  }
}

/** Forget a closing dialog's origin, returning it this one time. */
function release(event: Event): HTMLElement | null {
  if (!(event.target instanceof Element)) return null;
  const origin = origins.get(event.target) ?? null;
  origins.delete(event.target);
  return origin;
}

function restore(event: Event, origin: HTMLElement | null): void {
  if (event.defaultPrevented) return;
  // Radix's own handler would focus a trigger that does not exist.
  event.preventDefault();
  const active = document.activeElement;
  if (active !== null && active !== document.body) return;
  if (!origin?.isConnected) return;
  returning = true;
  try {
    origin.focus({ preventScroll: true });
  } finally {
    returning = false;
  }
}

/**
 * When `from` sits inside a dialog on its way out: the element that
 * dialog will hand focus back to. `returnsTo` is null when it hands focus
 * nowhere this hook knows of (not one of its dialogs, opened from
 * <body>, or the origin has left the document). Returns null when `from`
 * is inside no closing dialog.
 *
 * The dispatcher asks this for ⌘K. A keystroke pressed during the exit
 * lands in the closing dialog's own input, and it has to be judged by
 * where the member is about to be (`paletteOffersPageRows`).
 */
export function leavingDialogReturn(from: Element): { returnsTo: HTMLElement | null } | null {
  const leaving = from.closest(CLOSING_DIALOG);
  if (leaving === null) return null;
  const origin = origins.get(leaving) ?? null;
  return { returnsTo: origin?.isConnected ? origin : null };
}

/**
 * Whether the focus event being handled RIGHT NOW is this hook putting
 * focus back. Radix's `TooltipTrigger` opens its tooltip on any focus no
 * pointer caused. Returning focus to a tooltip-wrapped button therefore
 * opened a tooltip nobody asked for, and its layer took the member's
 * next Escape.
 *
 * The shared `TooltipTrigger` wrapper (`src/components/ui/tooltip.tsx`)
 * calls `preventDefault()` on the trigger's React focus event while this
 * is true, so every tooltip trigger in the app keeps its tooltip shut on a
 * return — not only the ones someone remembered. Radix runs its own
 * handler after the caller's and skips it once the event is
 * default-prevented. The flag is set only across the synchronous
 * `focus()` call, which dispatches focus events before it returns, so a
 * later focus never sees it.
 */
export const isReturningFocus = (): boolean => returning;

/**
 * FOCUS GOES BACK WHERE IT CAME FROM, for a Radix dialog that nothing
 * opens from a trigger: the ⌘K palette and MovePicker (`CommandDialog`),
 * the `?` overlay, and the shell's More sheet. On close Radix calls
 * `preventDefault()` and focuses the TRIGGER. With no trigger, that
 * focuses nothing and focus falls to <body>. No suppression guard covers
 * <body>, so every single key then acted behind whatever layer was still
 * open underneath (⌘K from a due-date day, Escape, `p` stacked a second
 * picker on the first).
 *
 * Spread the result onto the `DialogContent` or `SheetContent`. The
 * element that had focus when the dialog OPENED is refocused when it
 * closes. When the dialog opened from inside another such dialog that
 * was already closing, the element refocused is THAT dialog's origin.
 * The refocus happens only while it still makes sense:
 *  · the element must still be in the document. A remounted node is
 *    skipped; the board hands focus to a moved card's new node itself.
 *  · focus must have nowhere better to be. Whatever already took focus
 *    keeps it, such as the picker a palette row opened a frame later, or
 *    the overlay a palette row opened in the same batch.
 *
 * The origin is captured in `onOpenAutoFocus`, which Radix dispatches
 * only while focus is still OUTSIDE the content. So NO CHILD MAY USE
 * `autoFocus`: React focuses such an element during commit, before
 * Radix's mount effect, and the event is then never sent.
 * `src/lib/keymap.test.ts` pins that for every caller of this hook.
 *
 * A caller's own handlers compose. `onOpenAutoFocus` runs after the
 * capture. `onCloseAutoFocus` runs FIRST, and a `preventDefault()` in it
 * means the caller placed focus itself.
 */
export function useFocusReturn(
  handlers: { onOpenAutoFocus?: AutoFocusHandler; onCloseAutoFocus?: AutoFocusHandler } = {},
): { onOpenAutoFocus: AutoFocusHandler; onCloseAutoFocus: AutoFocusHandler } {
  return {
    onOpenAutoFocus: (event) => {
      capture(event);
      handlers.onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus: (event) => {
      // The entry goes first, so a caller's handler that throws cannot
      // leave it behind.
      const origin = release(event);
      handlers.onCloseAutoFocus?.(event);
      restore(event, origin);
    },
  };
}
