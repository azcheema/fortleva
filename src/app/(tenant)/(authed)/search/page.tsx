import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { Page, PageHeader } from "@/components/semantic";
import { requireTenantContext } from "@/members/tenant-context";
import { search } from "@/search/query";

import { SearchInput } from "./search-input";
import { SearchResults } from "./search-results";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("search") };
}

/**
 * `/search` (UI.md §3.1; DATA_MODEL.md §6.19).
 *
 * THE QUERY IS A SERVER PARAM, and the whole page re-renders for it —
 * the opposite of the backlog's filter chips, and for the same reason
 * the inbox's buckets are: there is no client-side copy of the corpus
 * to filter. Every keystroke that reaches here is a real query against
 * `search_index`, which is also why the input debounces before it
 * navigates.
 *
 * The page holds no gate of its own. `search()` carries all of them —
 * the scope filter, the per-type permission gate through
 * `requireAccess`, and the hydrate that drops anything whose source is
 * gone — so a surface cannot forget one by rendering results it was
 * handed.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const q = typeof query["q"] === "string" ? query["q"] : "";
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("search");

  const outcome = q.trim().length
    ? await search({ tenantId: membership.tenantId, actor }, q)
    : null;

  return (
    <Page>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="mt-4 flex flex-col gap-4">
        <SearchInput initial={q} />
        <SearchResults
          outcome={
            outcome === null
              ? { kind: "idle" }
              : outcome.kind === "empty-query"
                ? { kind: "empty-query" }
                : {
                    kind: "results",
                    hits: outcome.hits.map((h) => ({
                      entityType: h.entityType,
                      entityId: h.entityId,
                      title: h.title,
                      subtitle: h.subtitle,
                      href: h.href,
                      stateCategory: h.stateCategory,
                    })),
                  }
          }
        />
      </div>
    </Page>
  );
}
