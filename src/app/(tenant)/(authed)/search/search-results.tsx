"use client";

import {
  Building2Icon,
  FileTextIcon,
  FolderKanbanIcon,
  MessageSquareIcon,
  SearchIcon,
  SquareCheckIcon,
  UserRoundIcon,
  type LucideProps,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { EmptyState } from "@/components/semantic";
import { StatusIcon } from "@/components/semantic";
import { STATUS_MAP, type StatusValue } from "@/lib/enum-map";
import type { SearchEntityType } from "@/search/shape";

/**
 * The results list.
 *
 * FOUR STATES, and they are four because collapsing any two of them
 * lies to somebody (UI.md §5.8):
 *   idle        nothing typed yet          -> say what is searchable
 *   empty-query the query said nothing     -> ask for a real word
 *   none        a real query, no matches   -> that is an answer
 *   results     rows
 * "the" and "no results" are the two that get conflated most easily,
 * and they mean opposite things to the person reading them.
 *
 * The order is the SERVER's (`ts_rank_cd`, then recency) and nothing
 * here re-sorts it. Grouping is by type only for the heading; the rows
 * inside a group keep the order they arrived in.
 */

const ICON: Record<SearchEntityType, React.ComponentType<LucideProps>> = {
  WORK_ITEM: SquareCheckIcon,
  COMMENT: MessageSquareIcon,
  DOCUMENT: FileTextIcon,
  PROJECT: FolderKanbanIcon,
  CLIENT: Building2Icon,
  CONTACT: UserRoundIcon,
};

/** Type -> the `search.types.*` message key. An explicit map, so adding
 * a type without copy is a type error rather than a raw key on screen —
 * the discipline `notify/kind-copy.ts` records. */
const TYPE_KEY: Record<SearchEntityType, string> = {
  WORK_ITEM: "workItem",
  COMMENT: "comment",
  DOCUMENT: "document",
  PROJECT: "project",
  CLIENT: "client",
  CONTACT: "contact",
};

export type SearchResultView = {
  entityType: SearchEntityType;
  entityId: string;
  title: string;
  subtitle: string | null;
  href: string;
  stateCategory: string | null;
};

export type ResultsOutcome =
  | { kind: "idle" }
  | { kind: "empty-query" }
  | { kind: "results"; hits: SearchResultView[] };

export function SearchResults({ outcome }: { outcome: ResultsOutcome }) {
  const t = useTranslations("search");

  if (outcome.kind === "idle") {
    return (
      <EmptyState
        variant="filtered"
        // A plain magnifier. The `filtered` default is SearchXIcon — a
        // search with an X through it, i.e. "nothing found" — which is
        // the wrong thing to show before anything has been searched.
        icon={SearchIcon}
        title={t("idle.title")}
        body={t("idle.body")}
      />
    );
  }
  if (outcome.kind === "empty-query") {
    return (
      <EmptyState variant="filtered" title={t("vague.title")} body={t("vague.body")} />
    );
  }
  if (outcome.hits.length === 0) {
    return (
      <EmptyState variant="filtered" title={t("none.title")} body={t("none.body")} />
    );
  }

  // Grouped for the headings, in the order the types first appear — so
  // the highest-ranked type leads, rather than a fixed list order.
  const groups: { type: SearchEntityType; hits: SearchResultView[] }[] = [];
  for (const hit of outcome.hits) {
    const existing = groups.find((g) => g.type === hit.entityType);
    if (existing) existing.hits.push(hit);
    else groups.push({ type: hit.entityType, hits: [hit] });
  }

  return (
    <div data-testid="search-results" className="flex flex-col gap-6">
      {groups.map((group) => {
        const Icon = ICON[group.type];
        return (
          <section key={group.type}>
            <h2 className="eyebrow text-muted-foreground">
              {t(`types.${TYPE_KEY[group.type]}` as "types.workItem")}
            </h2>
            <ul className="mt-2 overflow-hidden rounded-card border border-border bg-card">
              {group.hits.map((hit) => {
                const state = hit.stateCategory
                  ? STATUS_MAP.stateCategory[hit.stateCategory as StatusValue<"stateCategory">]
                  : null;
                return (
                  <li
                    key={`${hit.entityType}:${hit.entityId}`}
                    data-testid="search-hit"
                    data-entity-type={hit.entityType}
                    className="border-b border-border last:border-b-0"
                  >
                    <Link
                      href={hit.href}
                      className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    >
                      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">{hit.title}</span>
                      {state ? (
                        <StatusIcon
                          name={state.icon}
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                      ) : null}
                      {hit.subtitle ? (
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {hit.subtitle}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
