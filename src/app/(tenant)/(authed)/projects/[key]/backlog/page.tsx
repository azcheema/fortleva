import { getTranslations } from "next-intl/server";

import { EmptyState, SectionCard } from "@/components/semantic";

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
 * is coming rather than an apology: five ghost rows at the real 36px
 * rhythm, with the priority glyph's geometry (bars, never hue) already
 * in its column.
 *
 * Decorative only (aria-hidden); the empty state carries the message.
 */
export default async function ProjectBacklogPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await loadProject(key);
  const t = await getTranslations("projects.backlog");

  return (
    <SectionCard contentClassName="flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
      <EmptyState variant="empty" title={t("title")} body={t("description")} />
      <div
        aria-hidden="true"
        className="w-full shrink-0 divide-y divide-border overflow-hidden rounded-md border border-border lg:max-w-md xl:max-w-xl"
      >
        {ROWS.map((row, i) => (
          <div key={i} className="flex h-9 items-center gap-3 px-3">
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
    </SectionCard>
  );
}
