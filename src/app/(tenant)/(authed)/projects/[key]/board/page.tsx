import { KanbanSquareIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { EmptyState, SectionCard, StatusIcon } from "@/components/semantic";
import { STATUS_MAP } from "@/lib/enum-map";

import { loadProject } from "../data";

/** The three categories the board will open with; TRIAGE and the rest arrive with 2W. */
const COLUMNS = ["TODO", "IN_PROGRESS", "DONE"] as const;
const CARDS: Record<(typeof COLUMNS)[number], string[]> = {
  TODO: ["w-28", "w-20", "w-24"],
  IN_PROGRESS: ["w-24", "w-16"],
  DONE: ["w-20"],
};

/**
 * Board arrives with the Work module (Phase 2W). Until then the tab is
 * not a dead end: BELOW the empty state — one column, text first — sits
 * a quiet, static preview of the shape that is coming.
 *
 * It is deliberately not a `<Skeleton>`: a shimmering grey block says
 * "this is loading", and this is not loading. The ghosts are
 * outline-only, 1px `--border` on a transparent fill, under a "Preview"
 * eyebrow that names them in words. Decoration in the accessibility
 * tree (aria-hidden); the empty state's words are the content.
 *
 * Below `md` it renders the single-column list shape §3.3 specifies for
 * a phone — three crushed columns is not what the board will be there.
 */
export default async function ProjectBoardPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await loadProject(key);
  const t = await getTranslations("projects.board");
  const tCommon = await getTranslations("common");
  const tStates = await getTranslations("states.stateCategory");

  return (
    <SectionCard contentClassName="flex flex-col gap-6">
      <EmptyState
        variant="empty"
        icon={KanbanSquareIcon}
        title={t("title")}
        body={t("description")}
      />
      <div className="flex flex-col gap-2">
        <p className="eyebrow text-muted-foreground">{tCommon("preview")}</p>
        <div aria-hidden="true" className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {COLUMNS.map((category) => (
            <div
              key={category}
              className="flex flex-col gap-2 rounded-md border border-dashed border-border p-2"
            >
              <div className="flex items-center gap-1.5 eyebrow text-muted-foreground">
                <StatusIcon
                  name={STATUS_MAP.stateCategory[category].icon}
                  className="size-3 shrink-0"
                />
                <span className="truncate">{tStates(category)}</span>
              </div>
              {CARDS[category].map((width, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-1.5 rounded-sm border border-border p-2"
                >
                  <span className={`block h-1.5 rounded-full bg-muted ${width}`} />
                  <span className="block h-1.5 w-12 rounded-full bg-muted" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}
