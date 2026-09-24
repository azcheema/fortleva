import { useEffect, useRef } from "react";

/**
 * Move focus to the page's `<h1>` whenever `view` CHANGES — never on the
 * first render.
 *
 * Both reset forms replace themselves: "Check your email", "Password saved"
 * and the dead-link state each unmount the form the person was using, and
 * the focused button goes with it, which drops focus onto `<body>`. A
 * screen-reader user is then left nowhere, told nothing (review finding).
 * The live region beside each form says WHAT happened; this puts them at
 * the top of what is now on the page.
 *
 * Compared against the previous value rather than a "first run" flag, so
 * React's development double-invocation of effects cannot mistake the
 * initial mount for a change and steal focus on arrival.
 *
 * `tabindex="-1"` makes the heading focusable without adding it to the tab
 * order, and `outline-none` because it is a landing point, not a control.
 */
export function useFocusHeadingOnChange(view: string): void {
  const previous = useRef(view);
  useEffect(() => {
    if (previous.current === view) return;
    previous.current = view;
    const heading = document.querySelector<HTMLElement>("main h1");
    if (!heading) return;
    heading.setAttribute("tabindex", "-1");
    heading.classList.add("outline-none");
    heading.focus();
  }, [view]);
}
