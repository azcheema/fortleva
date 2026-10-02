import { createClipboardGuard, type ClipboardGuard } from "@/lib/clipboard-guard";

/**
 * The page's ONE clipboard guard (`src/lib/clipboard-guard.ts`), bound to
 * the window on first use and kept for the life of the page — so a clear
 * that is still owed survives a client navigation from one client's vault
 * to another's. Browser-only: called from click handlers, never at import.
 */

let guard: ClipboardGuard | null = null;

const toBlob = (text: string) => new Blob([text], { type: "text/plain" });

const SECRET_SLOTS = '[data-slot="secret-field"], [data-slot="totp-field"]';

/** A copy now would put a real selection on the clipboard, and not one inside a secret's own field. */
function copiesNonSecretSelection(): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const selected = active.selectionStart !== null && active.selectionStart !== active.selectionEnd;
    return selected && active.closest(SECRET_SLOTS) === null;
  }
  const selection = document.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return false;
  const node = selection.getRangeAt(0).commonAncestorContainer;
  const element = node instanceof Element ? node : node.parentElement;
  return element !== null && element.closest(SECRET_SLOTS) === null;
}

export function vaultClipboard(): ClipboardGuard {
  if (guard) return guard;
  guard = createClipboardGuard({
    write: (text) => {
      if (typeof text !== "string" && typeof ClipboardItem !== "undefined") {
        // The write must START inside the click (Safari); the item carries
        // the promise, and the browser waits for the value.
        return navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then(toBlob) })]);
      }
      return Promise.resolve(text).then((t) => navigator.clipboard.writeText(t));
    },
    hasFocus: () => document.hasFocus(),
    // Coming back: the window regaining focus (another program), or this
    // tab becoming visible again (another tab of the browser).
    onReturn: (fn) => {
      const onVisible = () => {
        if (document.visibilityState === "visible") fn();
      };
      window.addEventListener("focus", fn);
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        window.removeEventListener("focus", fn);
        document.removeEventListener("visibilitychange", onVisible);
      };
    },
    // A click anywhere in the page — the gesture Firefox and Safari want
    // before a clear, and the one iOS honours for a touch (its pointerdown
    // is not). Capture phase, so nothing in the page can stop it; never a
    // key, so a paste (Ctrl+V) into a field here is not raced by an
    // emptying write. A click on a vault COPY button is left alone: that
    // copy replaces the clipboard itself, and an emptying write racing its
    // pending write could cancel it.
    onActivation: (fn) => {
      const onClick = (e: MouseEvent) => {
        if (e.target instanceof Element && e.target.closest("[data-vault-copy]")) return;
        fn();
      };
      document.addEventListener("click", onClick, true);
      return () => document.removeEventListener("click", onClick, true);
    },
    // A copy or cut that REPLACES the clipboard with something that is not
    // a secret settles the owed clear. Not any copy event: Firefox fires
    // one on Ctrl+C with nothing selected and leaves the clipboard alone,
    // and copying a REVEALED value natively puts a secret there — both keep
    // the clear owed (review round 3).
    onSuperseded: (fn) => {
      const onCopy = (e: ClipboardEvent) => {
        if (e.isTrusted && copiesNonSecretSelection()) fn();
      };
      document.addEventListener("copy", onCopy);
      document.addEventListener("cut", onCopy);
      return () => {
        document.removeEventListener("copy", onCopy);
        document.removeEventListener("cut", onCopy);
      };
    },
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
  });
  return guard;
}
