import { ListIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import type { CSSProperties } from "react";

import { EmptyState, ROW_HEIGHT, SectionCard } from "@/components/semantic";

import { loadProject } from "../data";

/** Ghost rows: key, title, priority geometry — the backlog's real rhythm at 36px. */
const ROWS = [
  { title: "w-40", bars: 3 },
  { title: "w-32", bars: 2 },
  { title: "w-48", bars: 1 },
  { title: "w-36", bars: 2 },
  { title: "w-28", bars: 0 },
] as const;

const BAR_HEIGHTS = ["h-1.5", "h-2", "h-2.5"] as const;

/**
 * Backlog arrives with the Work module (Phase 2W). The tab shows what
 * is coming rather than an apology: below the empty state, in the same
 * column and at the full column width, five ghost rows inside the real
 * `<DataTable>` at the real `--row-h`, with the priority glyph's
 * geometry (bars, never hue) already in its column.
 *
 * Outline-only and under a "Preview" eyebrow, so it cannot be mistaken
 * for a `<Skeleton>` that is about to resolve. Decorative
 * (aria-hidden); the empty state carries the message.
 */
export default async function ProjectBacklogPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await loadProject(key);
  const t = await getTranslations("projects.backlog");
  const tCommon = await getTranslations("common");

  return (
    <SectionCard contentClassName="flex flex-col gap-6">
      {/* NOT variant="empty": that one means "nothing here yet, make
          the first one", and its type demands the verb that does it.
          The Work module does not exist yet, so there is no verb to
          offer and inventing one would be a lie. `forbidden` is the
          honest shape — the thing is real, it is just not yours to use
          on this route today. */}
      <EmptyState
        variant="forbidden"
        icon={ListIcon}
        title={t("title")}
        body={t("description")}
      />
      <div className="flex flex-col gap-2">
        <p className="eyebrow text-muted-foreground">{tCommon("preview")}</p>
        {/* The real --row-h and the real card surface, so the preview is
            the coming table's rhythm rather than an approximation of it —
            but NOT a <DataTable>, which is a focusable `role="region"`
            and would put a tab stop inside an aria-hidden subtree. */}
        <div
          aria-hidden="true"
          style={{ "--row-h": ROW_HEIGHT.default } as CSSProperties}
          className="w-full divide-y divide-border rounded-card border border-dashed border-border bg-card"
        >
          {ROWS.map((row, i) => (
            <div key={i} className="row-h flex items-center gap-3 px-3">
              <span className="block h-1.5 w-10 rounded-full bg-muted" />
              <span className={`block h-1.5 rounded-full bg-muted ${row.title}`} />
              <span className="ml-auto inline-flex h-3 items-end gap-px">
                {BAR_HEIGHTS.map((height, b) => (
                  <span
                    key={b}
                    className={`block w-0.75 rounded-full bg-muted ${height} ${b < row.bars ? "" : "invisible"}`}
                  />
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}
