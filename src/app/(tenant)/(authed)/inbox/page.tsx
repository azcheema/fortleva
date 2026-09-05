import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { Page, PageHeader } from "@/components/semantic";
import { TabNav, type TabLink } from "@/components/tab-nav";
import { requireTenantContext } from "@/members/tenant-context";
import { INBOX_FILTERS, isInboxFilter, listInbox, type InboxFilter } from "@/notify/inbox";

import { InboxList } from "./inbox-list";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("inbox") };
}

/**
 * `/inbox` (UI.md §3.1 — "Core; unread badge"): the member's own
 * notifications, in four buckets.
 *
 * THE BUCKET IS A SERVER PARAM, not a client predicate — the opposite
 * of the backlog's filter chips, and for the reason that decides it
 * there: the backlog already holds every item of the project in the
 * browser, so filtering it is arithmetic; here each bucket is a
 * different `WHERE` against a paged table, so a bucket is a navigation.
 * That also keeps the four buckets addressable and back/forward honest.
 *
 * The list is a Client Component only because its verbs are optimistic;
 * the rows, the resolution of what each notification is ABOUT, and the
 * scope filtering that makes that safe all happen here, on the server.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const raw = typeof query["filter"] === "string" ? query["filter"] : undefined;
  // An unknown bucket is not an error — it is the default one. A 404 on
  // a stale bookmark of a bucket we later rename would be a worse
  // answer than the inbox itself.
  const filter: InboxFilter = isInboxFilter(raw) ? raw : "unread";
  const cursor = typeof query["cursor"] === "string" ? query["cursor"] : undefined;

  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("inbox");
  const page = await listInbox({ tenantId: membership.tenantId, actor }, { filter, cursor });

  const tabs: TabLink[] = INBOX_FILTERS.map((f) => ({
    href: f === "unread" ? "/inbox" : `/inbox?filter=${f}`,
    label: t(`tabs.${f}` as "tabs.unread"),
    active: f === filter,
  }));

  return (
    <Page>
      <PageHeader title={t("title")} description={t("description")} />
      <TabNav tabs={tabs} className="mt-4" />
      <InboxList
        filter={filter}
        rows={page.rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          createdAt: r.createdAt.toISOString(),
          read: r.readAt !== null,
          archived: r.archivedAt !== null,
          snoozedTill: r.snoozedTill?.toISOString() ?? null,
          subject: r.subject ?? null,
        }))}
        serverNow={new Date().toISOString()}
        nextHref={
          page.nextCursor
            ? `/inbox?${new URLSearchParams(
                filter === "unread"
                  ? { cursor: page.nextCursor }
                  : { filter, cursor: page.nextCursor },
              ).toString()}`
            : null
        }
      />
    </Page>
  );
}
