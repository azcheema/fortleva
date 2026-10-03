import { ReceiptIcon } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { ASSET_ICON } from "@/app/(tenant)/(authed)/clients/[id]/assets/asset-icons";
import { daysBetween, SOON_DAYS } from "@/app/(tenant)/(authed)/clients/[id]/assets/asset-shape";
import { Badge } from "@/components/ui/badge";
import type { ExpirationEntry } from "@/modules/vault";

/**
 * Where a row leads: the asset's own line on the client's Assets tab, or the
 * client's Agreements tab — only where that page would open for the member
 * (`linkable`: `client:view`, and direct assignment for an agreement).
 */
export function expirationHref(e: ExpirationEntry): string | null {
  if (!e.linkable) return null;
  return e.kind === "asset" ? `/clients/${e.client.id}/assets#asset-${e.id}` : `/clients/${e.client.id}/agreements`;
}

/**
 * Rows of the expirations feed — `/expirations` and the Home card draw the
 * same row (Phase 3V slice 88). Server-rendered with the member's TODAY
 * (worked out by the page in the member's zone), so the days left and the
 * date are the server's text and never a second clock's (the process-zone
 * hydration trap). A row is ONE link to where the thing is renewed — the
 * triage card's rule — except where that page would refuse the member
 * (`linkable`: no `client:view`, or an agreement's tab without direct
 * assignment), which is the line without the link.
 */
export async function ExpirationList({
  entries,
  today,
  testId,
}: {
  entries: readonly ExpirationEntry[];
  today: string;
  testId?: string;
}) {
  const t = await getTranslations("expirations");
  const tAssets = await getTranslations("assets");
  const format = await getFormatter();

  return (
    <ul data-testid={testId}>
      {entries.map((e) => {
        const Icon = e.kind === "asset" && e.assetType !== null ? ASSET_ICON[e.assetType] : ReceiptIcon;
        const days = daysBetween(today, e.date);
        const what =
          e.kind === "asset" ? (e.assetType === null ? "" : tAssets(`types.${e.assetType}`)) : t(`kinds.${e.kind}`);
        const meta = [e.client.name, e.project?.key, what].filter(Boolean).join(" · ");
        const dateLabel = format.dateTime(new Date(`${e.date}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
        const cue = cueOf(e, days);
        const href = expirationHref(e);
        const body = (
          <>
            <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{e.name}</span>
              <span className="truncate text-xs text-muted-foreground">{meta}</span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-0.5">
              <span className="num text-xs text-muted-foreground">{dateLabel}</span>
              {cue ? (
                <Badge variant={cue.tone} data-testid="expiration-cue">
                  {t(`cue.${cue.key}`, { days: Math.abs(days) })}
                </Badge>
              ) : null}
            </span>
          </>
        );
        return (
          <li
            key={`${e.kind}:${e.id}`}
            className="border-t border-border first:border-t-0"
            data-testid="expiration-row"
            data-kind={e.kind}
            data-name={e.name}
          >
            {href ? (
              <Link
                href={href}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              >
                {body}
              </Link>
            ) : (
              <div className="flex items-center gap-3 px-4 py-2.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

type Cue = {
  readonly key:
    | "expired"
    | "expiresToday"
    | "expiresIn"
    | "renewsToday"
    | "renewsIn"
    | "endsToday"
    | "endsIn"
    | "endPassed";
  readonly tone: "danger" | "caution" | "neutral" | "quiet";
};

/**
 * The words and the weight of a row's date — the Assets tab's cue, so one
 * asset reads the same in both places: past it is danger; an asset that
 * lapses TODAY is danger too; within `SOON_DAYS` is caution — or neutral
 * when it renews by itself, an agreement's renewal included — and an
 * agreement ending today is caution; further out it is quiet.
 */
function cueOf(e: ExpirationEntry, days: number): Cue {
  const near = days <= SOON_DAYS;
  if (e.kind === "agreementEnds") {
    if (days < 0) return { key: "endPassed", tone: "danger" };
    if (days === 0) return { key: "endsToday", tone: "caution" };
    return { key: "endsIn", tone: near ? "caution" : "quiet" };
  }
  const renews = e.kind === "agreementRenews" || e.autoRenew === true;
  // An agreement's renewal is never in the past here: the feed reads
  // renewals from today on (`expirations.ts`), so only an asset lapses.
  if (days < 0) return { key: "expired", tone: "danger" };
  if (days === 0) return renews ? { key: "renewsToday", tone: "neutral" } : { key: "expiresToday", tone: "danger" };
  if (renews) return { key: "renewsIn", tone: near ? "neutral" : "quiet" };
  return { key: "expiresIn", tone: near ? "caution" : "quiet" };
}
