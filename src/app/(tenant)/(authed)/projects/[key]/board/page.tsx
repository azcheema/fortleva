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
 * not a dead end: beside the empty state sits a quiet, static preview
 * of the shape that is coming — columns are states, position is
 * priority — drawn from the same surface ladder as the real thing.
 *
 * It is decoration in the accessibility tree (aria-hidden) and carries
 * no colour of its own: the empty state's words are the content, and
 * the preview is there so the promise is legible rather than merely
 * announced. Deliberately not an illustration (DESIGN SPEC §1).
 */
export default async function ProjectBoardPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await loadProject(key);
  const t = await getTranslations("projects.board");
  const tStates = await getTranslations("states.stateCategory");

  return (
    <SectionCard contentClassName="flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
      <EmptyState variant="empty" title={t("title")} body={t("description")} />
      <div
        aria-hidden="true"
        className="grid w-full shrink-0 grid-cols-3 gap-3 lg:max-w-md xl:max-w-xl"
      >
        {COLUMNS.map((category) => (
          <div key={category} className="flex flex-col gap-2 rounded-md bg-muted p-2">
            <div className="flex items-center gap-1.5 text-2xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              <StatusIcon
                name={STATUS_MAP.stateCategory[category].icon}
                className="size-3 shrink-0"
              />
              <span className="truncate">{tStates(category)}</span>
            </div>
            {CARDS[category].map((width, i) => (
              <div
                key={i}
                className="flex flex-col gap-1.5 rounded-sm border border-border bg-card p-2"
              >
                <span className={`block h-1.5 rounded-full bg-muted ${width}`} />
                <span className="block h-1.5 w-12 rounded-full bg-muted" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
