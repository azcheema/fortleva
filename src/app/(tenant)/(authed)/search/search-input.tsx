"use client";

import { SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";

import { Input } from "@/components/ui/input";
import { Pending } from "@/components/semantic";
import { MAX_QUERY_CHARS } from "@/search/shape";

/**
 * The query box. It owns the text, the URL owns the query.
 *
 * DEBOUNCED, because every navigation is a real scan of the tenant's
 * index — there is no GIN under FORCE RLS (§6.19), so a keystroke is
 * not free the way a client-side filter is.
 *
 * `replace`, not `push`: a search that is being refined is one view, not
 * twelve, and ten characters typed must not become ten Back presses.
 * The same call the backlog's filter bar makes, for the same reason.
 *
 * IT FOLLOWS A NAVIGATION IT DID NOT CAUSE, and only that one. Writing
 * `initial` back into the box on every change would make a fast typist
 * watch their own characters reorder, because `initial` changes on
 * every navigation this component itself just made. So it remembers
 * what it last sent and re-syncs only when `initial` disagrees with
 * that — which happens when the rail's own Search link resets the URL
 * to `/search` while the box still reads the old query, and the page
 * below already says "Type to search".
 */
export function SearchInput({ initial }: { initial: string }) {
  const t = useTranslations("search");
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [pending, startTransition] = useTransition();
  const timer = useRef<number | undefined>(undefined);
  /** The query this box last put in the URL. State, not a ref: the
   * render adjustment below reads it, and refs may not be read during
   * render. */
  const [sent, setSent] = useState(initial);
  const [lastInitial, setLastInitial] = useState(initial);

  // React's "adjusting state when a prop changes", not an effect.
  if (initial !== lastInitial) {
    setLastInitial(initial);
    if (initial !== sent) setValue(initial);
  }

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Cancel an armed debounce when the URL changed under us. Without
  // this, clearing the box via the rail's own Search link is silently
  // undone 250 ms later by the keystroke that was still pending —
  // results for a query the box no longer shows.
  useEffect(() => {
    if (initial !== sent) window.clearTimeout(timer.current);
  }, [initial, sent]);

  const commit = (next: string) => {
    setValue(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      startTransition(() => {
        const trimmed = next.trim();
        setSent(trimmed);
        router.replace(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search");
      });
    }, 250);
  };

  return (
    <div className="relative">
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        autoFocus
        value={value}
        maxLength={MAX_QUERY_CHARS}
        onChange={(e) => commit(e.currentTarget.value)}
        aria-label={t("label")}
        placeholder={t("placeholder")}
        className="pl-9"
      />
      {pending ? (
        <span className="absolute top-1/2 right-3 -translate-y-1/2">
          <Pending label={t("searching")} />
        </span>
      ) : null}
    </div>
  );
}
