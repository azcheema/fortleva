"use client";

import {
  Building2Icon,
  FileTextIcon,
  FolderKanbanIcon,
  KeyboardIcon,
  KeyRoundIcon,
  LanguagesIcon,
  LockIcon,
  LogOutIcon,
  MessageSquareIcon,
  SquareCheckIcon,
  UserRoundIcon,
  type LucideProps,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";

import type { NavEntry } from "@/app/(tenant)/(authed)/nav";
import { KeyboardHint } from "@/components/semantic/keyboard-hint";
import {
  Command,
  CommandDialog,
  CommandEmptyState,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useVaultDeadline } from "@/components/vault/use-vault-deadline";
import { LOCALES } from "@/i18n/config";
import { overlaySections } from "@/lib/keymap";
import { emptyScopes, runScopeBinding, scopeSnapshot, subscribeScopes, useScopeKeys } from "./use-hotkeys";
import { matchesQuery } from "@/lib/text-match";
import { paletteSearchAction, type PaletteHit } from "@/app/(tenant)/(authed)/search/actions";
import type { SearchEntityType } from "@/search/shape";

import { NavIcon } from "./nav-icon";

/** Flatten the visible nav (parents with children contribute their children). */
export const flatNav = (entries: readonly NavEntry[]): NavEntry[] =>
  entries.flatMap((e) => (e.children ? flatNav(e.children) : [e]));

/**
 * ⌘K palette (UI.md §3.2, rule 7): every action reachable from here —
 * navigation, entity search, switch language, keyboard shortcuts, sign
 * out.
 *
 * `shouldFilter={false}`, AND THAT IS NOT A DETAIL. cmdk's default both
 * filters items by fuzzy score and RE-SORTS the DOM by it. Entity rows
 * arrive ranked by `ts_rank_cd` and then recency — the server's answer
 * to "what did they mean" — and a ranking something else re-sorts is
 * not a ranking. Turning it off means this component owns matching for
 * the NAV rows too, which `matchesQuery` (`@/lib/text-match`, shared
 * with the property pickers) does with a subsequence test so "prj"
 * still reaches Projects.
 *
 * Every entity row's `value` is `type:id`. cmdk tracks selection as a
 * single string and marks EVERY item whose value equals it, so two rows
 * sharing a value both light up and Enter fires whichever is first in
 * the DOM.
 */

/** One glyph per type, the same set `/search` uses. */
const ENTITY_ICON: Record<SearchEntityType, React.ComponentType<LucideProps>> = {
  WORK_ITEM: SquareCheckIcon,
  COMMENT: MessageSquareIcon,
  DOCUMENT: FileTextIcon,
  PROJECT: FolderKanbanIcon,
  CLIENT: Building2Icon,
  CONTACT: UserRoundIcon,
  CREDENTIAL_ITEM: KeyRoundIcon,
};

type Answered = {
  q: string;
  rows: PaletteHit[];
  vaultLocked: boolean;
  /** The open vault's window an answer holding a LOGIN was searched under. */
  lock: { key: string; msLeft: number } | null;
};

const NOTHING_ANSWERED: Answered = { q: "", rows: [], vaultLocked: false, lock: null };

export function CommandPalette({
  open,
  onOpenChange,
  nav,
  onSignOut,
  onSwitchLocale,
  onShowShortcuts,
  offerPageRows,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Whether the "On this page" group may render. It is decided where the
   * palette was OPENED (`paletteOffersPageRows` in `@/lib/keymap`), and it
   * is REQUIRED, because a default here would be exactly the state a new
   * caller silently loses.
   */
  offerPageRows: boolean;
  nav: readonly NavEntry[];
  onSignOut: () => void;
  onSwitchLocale: (locale: string) => void;
  onShowShortcuts: () => void;
}) {
  const t = useTranslations("shell.palette");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const tVault = useTranslations("search.vaultLocked");
  const locale = useLocale();
  const router = useRouter();
  const [, startTransition] = useTransition();

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  // The live keyboard registry — the same snapshot the `?` overlay and
  // the dispatcher read.
  const scopes = useSyncExternalStore(subscribeScopes, scopeSnapshot, emptyScopes);

  const [query, setQuery] = useState("");
  // The rows AND the query they answer. cmdk keeps mounted items until
  // they are replaced, so without this a result row for the PREVIOUS
  // query stays on screen — and selectable — through the next 200 ms of
  // typing.
  // `vaultLocked` and `lock` travel WITH the rows, for the same reason:
  // they answer that query, and a line left over from the previous one
  // would mean nothing.
  const [answered, setAnswered] = useState<Answered>(NOTHING_ANSWERED);
  // SELECTION IS CONTROLLED, and it has to be. cmdk moves its highlight
  // on a SEARCH change only; item registration re-selects nothing when
  // something is already selected. Entity rows mount 200 ms after the
  // last keystroke, so the highlight stays wherever the query left it —
  // and if the query matched exactly one action row, that is "Sign out".
  // Typing `logg` on a Swedish tenant matched only `Logga ut`; Enter
  // signed the member out while they waited for results.
  const [selected, setSelected] = useState("");
  const timer = useRef<number | undefined>(undefined);
  // Monotonic, so a slow answer to an OLD query can never overwrite a
  // fast answer to a NEW one — the classic type-ahead defect, and the
  // reason this is a counter rather than an AbortController: the action
  // is a server function, not a fetch we can cancel.
  const issued = useRef(0);

  // Whether the palette is open, readable from an async callback. A ref
  // written in an EFFECT (allowed) rather than during render (not): a
  // timer already scheduled must not fire a search into a palette
  // nobody is looking at, and then repopulate it after the reset below
  // has already cleared it.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
    // Invalidate anything in flight AS the palette closes. The ticket
    // alone was not enough: nothing bumped it on close, so a result
    // that resolved between the reset render and this effect — or after
    // a fast close-then-reopen — landed rows under an empty box, and
    // clicking one navigated somewhere nobody asked to go.
    if (!open) {
      issued.current += 1;
      // AND cancel the armed timer. Bumping the ticket does nothing to a
      // timer that has not fired: its callback mints a NEW ticket, and
      // its only other guard is `openRef`, which is true again the
      // moment the palette reopens — so a close-then-reopen inside the
      // debounce window landed the previous query's rows under an empty
      // input.
      window.clearTimeout(timer.current);
    }
  }, [open]);

  // RESET DURING RENDER, not in an effect: React's documented
  // "adjusting state when a prop changes", which `use-server-now.ts`
  // already uses here — and which the set-state-in-effect lint rule
  // exists to push you towards. The palette is not unmounted when it
  // closes, so without this, reopening shows the previous search's rows
  // beneath a box that reads empty. It also cannot be done in
  // `onOpenChange`: the ⌘K hotkey toggles `open` in the shell directly,
  // never through that handler.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setQuery("");
      setAnswered(NOTHING_ANSWERED);
      setSelected("");
    }
  }

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // When the open vault an answer was searched under locks, its LOGIN rows
  // leave the palette and the locked line takes their place (slice 97's
  // reviews: a palette left open must not keep login names on a screen
  // past the window). The vault pages' own rule (`useVaultDeadline`) — at
  // the deadline, every 15 s and on return — because a bare timeout is
  // delayed by however long a laptop slept.
  useVaultDeadline(answered.lock, (expired) => {
    // Only the answer held under THAT window: a late check of an old one
    // must never strip a newer answer's logins.
    setAnswered((a) =>
      a.lock?.key === expired
        ? { ...a, rows: a.rows.filter((r) => r.entityType !== "CREDENTIAL_ITEM"), vaultLocked: true, lock: null }
        : a,
    );
    // No highlight reset here: when the lit login row unmounts, cmdk lights
    // the first row itself, and an unguarded reset could clear a NEWER
    // answer's highlight (the last review).
  });

  // While it is open the palette owns the keyboard — quick-create's and the
  // stop confirm's reason: its input and list are inert to single keys
  // (`inMenuLayer`), but the vault line's link below the cmdk root is
  // neither, and `T` there stopped the member's timer behind the scrim
  // (slice 97's fix-round review). `exclusive` FOLLOWS `open` — the standing
  // trap: register one unconditionally and every key in the app dies.
  useScopeKeys("modal", [], { exclusive: open });

  const onQueryChange = (next: string) => {
    setQuery(next);
    window.clearTimeout(timer.current);
    const trimmed = next.trim();
    if (trimmed.length === 0) {
      issued.current += 1;
      setAnswered(NOTHING_ANSWERED);
      return;
    }
    timer.current = window.setTimeout(() => {
      if (!openRef.current) return; // closed since it was scheduled
      const ticket = ++issued.current;
      void paletteSearchAction(trimmed)
        .then(({ hits: rows, vaultLocked, vaultMsLeft, vaultLocksAt }) => {
          if (ticket !== issued.current || !openRef.current) return;
          // Keyed by the WINDOW (its lock instant, as the vault pages key
          // theirs), measured on the server's clock: one window, one
          // deadline, however often the palette remounts.
          const lock =
            vaultMsLeft !== null && vaultLocksAt !== null && rows.some((r) => r.entityType === "CREDENTIAL_ITEM")
              ? { key: vaultLocksAt, msLeft: vaultMsLeft }
              : null;
          setAnswered({ q: trimmed, rows, vaultLocked, lock });
          // Put the highlight on the first result the moment it exists,
          // which is the one thing cmdk will not do for us.
          if (rows[0]) setSelected(rows[0].value);
        })
        // A failed search must not blank the navigation rows underneath
        // it: the palette is how someone gets somewhere.
        .catch(() => {
          if (ticket === issued.current && openRef.current) setAnswered({ ...NOTHING_ANSWERED, q: trimmed });
        });
    }, 200);
  };

  // Rows are shown only while they answer the query on screen.
  const current = answered.q === query.trim();
  const hits = current ? answered.rows : [];
  const vaultLocked = current && answered.vaultLocked;

  const navRows = flatNav(nav).filter((entry) =>
    matchesQuery(`${tNav(entry.labelKey)} ${entry.href}`, query),
  );

  // THE ACTION ROWS FILTER TOO, and that is a correctness fix rather
  // than tidiness. cmdk moves its highlight to the first item on every
  // SEARCH change, and the entity rows arrive 200 ms later — so with an
  // unfiltered Actions group, typing a query that matched no nav row
  // left the highlight sitting on "Switch language", and Enter changed
  // the member's language instead of opening the result they were
  // waiting for.
  const actionRows = {
    locales: LOCALES.filter((l) => l !== locale).filter((l) =>
      matchesQuery(`${t("switchLanguage")} ${tCommon(`languageName.${l}`)}`, query),
    ),
    shortcuts: matchesQuery(t("shortcuts"), query),
    signOut: matchesQuery(t("signOut"), query),
  };
  const hasActions =
    actionRows.locales.length > 0 || actionRows.shortcuts || actionRows.signOut;

  // Rule 7's other half: a single key owes the palette an entry as well
  // as an overlay row. These come from the same live registry snapshot
  // the `?` overlay renders, so a surface ships a key by adding ONE
  // `useScopeKeys` call and gets both for free — which is precisely what
  // the bulk bar and the inbox list were waiting for.
  //
  // Every scope, `global` included. Excluding `global` wholesale was
  // wrong on its own stated grounds: it claimed those keys "already have
  // palette rows", but the timer's `T` had neither a row nor an opt-out,
  // so its verb was reachable by the bare key alone — the exact rule-7
  // gap this group exists to close. A binding that genuinely duplicates
  // an existing row opts out where it is declared, with
  // `palette: false`, as `?` does.
  //
  // NONE AT ALL when the palette was opened from where a single key is
  // inert (`offerPageRows`). ⌘K is answered even inside an open picker,
  // and a row there ran a DIFFERENT picker's key: "Change priority" from
  // inside the due-date picker opened a second modal picker stacked on
  // the first. After one Escape, focus sat on a rail trigger that the
  // first picker was still hiding.
  const pageRows = offerPageRows
    ? overlaySections(scopes)
        .flatMap((s) =>
          s.bindings
            .filter((b) => b.run !== null && b.palette !== false)
            .map((b) => ({ ...b, scope: s.scope })),
        )
        .filter((b) => matchesQuery(b.label, query))
    : [];

  // Independent of the vault line, which is not a result: a query that
  // matched nothing says so, and the line below the list says why logins
  // were not among it (the review: "No results." must not vanish).
  const nothing =
    navRows.length === 0 && hits.length === 0 && !hasActions && pageRows.length === 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("title")}
      description={t("description")}
      // The dialog content is a `gap-4` grid: the vault line after the cmdk
      // root would otherwise float 16px below it, over a blank band.
      className="gap-0"
    >
      {/* The cmdk root. `CommandDialog` deliberately does not render one
          (see command.tsx): `shouldFilter` both filters and RE-SORTS by
          fuzzy score, so the surface has to choose — and this one has
          server-ranked entity rows, whose `ts_rank_cd` order cmdk must
          not touch. Every group below therefore does its own matching.
          `label` names the combobox — without it cmdk renders an empty
          <label> and the input falls back to its placeholder. */}
      <Command
        label={t("title")}
        shouldFilter={false}
        // cmdk defaults this TRUE, and its Ctrl+k means "previous item"
        // — which shadows the global ⌘K on Windows and Linux.
        vimBindings={false}
        value={selected}
        onValueChange={setSelected}
      >
        <CommandInput
          // No autofocus attribute: Radix's FocusScope focuses this, the
          // first tabbable element, on its own. An attribute would
          // pre-empt the open event that `CommandDialog` records the
          // focus origin in, and closing would drop focus on <body>.
          placeholder={t("placeholder")}
          value={query}
          onValueChange={onQueryChange}
        />
        <CommandList>
          {/* NOT `CommandEmpty`: with `shouldFilter={false}` cmdk sets
              its filtered count to the number of MOUNTED items, so its
              own Empty never renders and the string was unreachable. */}
          {nothing ? <CommandEmptyState>{t("empty")}</CommandEmptyState> : null}
          {hits.length > 0 ? (
            <>
              <CommandGroup heading={t("results")}>
                {hits.map((hit) => {
                  const Icon = ENTITY_ICON[hit.entityType];
                  return (
                    <CommandItem
                      key={hit.value}
                      value={hit.value}
                      onSelect={() => run(() => startTransition(() => router.push(hit.href)))}
                    >
                      <Icon aria-hidden="true" />
                      {/* min-w-0 flex-1, not bare `truncate`: a nowrap
                          flex child defaults to min-width:auto and
                          overflows instead of ellipsing, pushing the
                          subtitle out of the row. A COMMENT title is
                          140 characters. */}
                      <span className="min-w-0 flex-1 truncate">{hit.title}</span>
                      {hit.subtitle ? (
                        <CommandShortcut>{hit.subtitle}</CommandShortcut>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              <CommandSeparator />
            </>
          ) : null}
          {pageRows.length > 0 ? (
            <>
              <CommandGroup heading={t("onThisPage")}>
                {pageRows.map((b) => (
                  <CommandItem
                    // `value` is an ID, never the label: cmdk tracks
                    // selection as one string and marks EVERY item whose
                    // value matches, so two rows sharing one both light
                    // up and Enter fires whichever is first in the DOM.
                    key={`${b.scope}:${b.key}`}
                    value={`page:${b.scope}:${b.key}`}
                    onSelect={() =>
                      run(() =>
                        // One frame later, so the picker mounts after the
                        // palette has let go of the keyboard. The palette's
                        // focus return cannot steal the picker's focus:
                        // `CommandDialog` refocuses the element it was
                        // opened from only if nothing has taken focus by
                        // the time it closes, and the picker's search box
                        // has.
                        //
                        // Through `runScopeBinding`, NOT the `run` on this
                        // row: the row came from the version-cached
                        // snapshot, whose closures are deliberately
                        // allowed to be a commit old (`signatureOf`
                        // cannot see a closure). The keydown path has
                        // always re-read the live entry; this is the same
                        // read, so a key and its palette row cannot do
                        // two different things.
                        requestAnimationFrame(() =>
                          runScopeBinding(b.entry, b.index, new KeyboardEvent("keydown")),
                        ),
                      )
                    }
                  >
                    <span className="min-w-0 flex-1 truncate">{b.label}</span>
                    <CommandShortcut>
                      <KeyboardHint keys={b.hint ?? [b.key.toUpperCase()]} />
                    </CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
            </>
          ) : null}
          {navRows.length > 0 ? (
          <CommandGroup heading={t("navigate")}>
            {navRows.map((entry) => {
              const goLabel = entry.goKey ? `G ${entry.goKey}` : null;
              return (
                <CommandItem
                  key={entry.id}
                  value={`${tNav(entry.labelKey)} ${entry.href}`}
                  onSelect={() => run(() => startTransition(() => router.push(entry.href)))}
                >
                  <NavIcon name={entry.icon} />
                  <span>{tNav(entry.labelKey)}</span>
                  {goLabel ? <CommandShortcut>{goLabel}</CommandShortcut> : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
          ) : null}
          {navRows.length > 0 && hasActions ? <CommandSeparator /> : null}
          {hasActions ? (
            <CommandGroup heading={t("actions")}>
              {actionRows.locales.map((l) => (
                <CommandItem
                  key={l}
                  value={`${t("switchLanguage")} ${tCommon(`languageName.${l}`)}`}
                  onSelect={() => run(() => onSwitchLocale(l))}
                >
                  <LanguagesIcon />
                  <span>
                    {t("switchLanguage")}
                    {": "}
                    {tCommon(`languageName.${l}`)}
                  </span>
                </CommandItem>
              ))}
              {actionRows.shortcuts ? (
                <CommandItem value={t("shortcuts")} onSelect={() => run(onShowShortcuts)}>
                  <KeyboardIcon />
                  <span>{t("shortcuts")}</span>
                  <CommandShortcut>{"?"}</CommandShortcut>
                </CommandItem>
              ) : null}
              {actionRows.signOut ? (
                <CommandItem value={t("signOut")} onSelect={() => run(onSignOut)}>
                  <LogOutIcon />
                  <span>{t("signOut")}</span>
                </CommandItem>
              ) : null}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
      {vaultLocked ? (
        // Logins were not searched: the vault is locked (founder decision
        // C65 (a)). Drawn on EVERY answered search by a member who could
        // open the vault, never because a login matched. A LINE, not a
        // row (the review): as the only row it was what cmdk lit, so Enter
        // on a query that matched nothing went to /vault. And AFTER the
        // cmdk root, because that root's onKeyDown owns Enter for every
        // descendant (AGENTS.md) — inside it, Enter on the focused link
        // would have fired the lit row instead. Reached by Tab or a click.
        <p
          data-testid="palette-vault-locked"
          className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground"
        >
          <LockIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span>
            <span>{tVault("line")} </span>
            <Link
              href="/vault"
              onClick={() => onOpenChange(false)}
              className="rounded-sm text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {tVault("open")}
            </Link>
          </span>
        </p>
      ) : null}
    </CommandDialog>
  );
}
