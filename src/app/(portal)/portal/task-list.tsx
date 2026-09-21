import { useFormatter, useLocale, useTranslations } from "next-intl";

import { SectionCard, StatusIcon } from "@/components/semantic";
import { formatDay } from "@/lib/format";
import { STATUS_MAP } from "@/lib/enum-map";
import { PORTAL_TASK_CATEGORIES, type PortalProjectTasks, type PortalTaskCategory } from "@/modules/work";
import { TONE_CHIP } from "@/lib/tones";
import { cn } from "@/lib/utils";

/**
 * The shared task list, one card per project, grouped by the portal's
 * four categories (UI.md §11). What is NOT here is the point of the
 * file: no state name, no estimate, no label, no assignee, no ordering
 * weight, nothing a client would have to learn the agency's vocabulary
 * to read. The projection cannot supply any of it — see
 * `src/modules/work/portal.ts` — so this component could not render it
 * if it tried, which is the arrangement the pins ask for.
 *
 * Grouped by CATEGORY within the project, in the fixed order above, so
 * a client reads down the same three-or-four headings on every project
 * rather than a list whose shape changes with the data. A category with
 * nothing in it is simply absent — an empty "Done" heading on a project
 * that has not finished anything yet says nothing worth a row of space.
 */
export function ProjectTasks({ project }: { project: PortalProjectTasks }) {
  const t = useTranslations("portal.tasks");
  const tStates = useTranslations("states.portalTaskCategory");
  const locale = useLocale();
  const format = useFormatter();

  const groups = PORTAL_TASK_CATEGORIES.map((category) => ({
    category,
    tasks: project.tasks.filter((task) => task.category === category),
  })).filter((group) => group.tasks.length > 0);

  return (
    <SectionCard title={project.projectName} description={t("heading")} contentClassName="p-0">
      <div className="divide-y divide-border">
        {groups.map(({ category, tasks }) => (
          <section key={category} className="p-4">
            {/* The chip IS the heading — it carries its own size and
                tone from `TONE_CHIP`, so the h3 only positions it. */}
            <h3 className="mb-2 flex items-center">
              <CategoryChip category={category} label={tStates(category)} />
            </h3>
            <ul className="flex flex-col gap-2">
              {tasks.map((task) => (
                <li key={task.id} className="flex flex-col gap-0.5">
                  <span className="text-sm text-foreground">{task.title}</span>
                  {task.phase || task.targetDate || task.completedAt ? (
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      {task.phase ? <span>{t("phase", { name: task.phase })}</span> : null}
                      {task.targetDate ? (
                        <span>{t("due", { date: formatDay(locale, task.targetDate) })}</span>
                      ) : null}
                      {/* TWO DATES, TWO FORMATTERS, and the split is not
                          fussiness. `targetDate` is a `@db.Date` — UTC
                          midnight standing for a calendar day — so
                          `formatDay` pins it to UTC or the day shifts
                          west. `completedAt` is a real instant, so it
                          takes next-intl's zone, which on this plane is
                          the product default: a Contact has no timezone
                          column and `tenant` carries `portal_deny`, so
                          there is nothing better to read yet. The Portal
                          tab slice, which earns a system-principal read
                          for the agency's name, can pass its zone here
                          too. */}
                      {task.completedAt ? (
                        <span>
                          {t("completed", {
                            date: format.dateTime(task.completedAt, {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                            }),
                          })}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </SectionCard>
  );
}

/**
 * The category, drawn the way every other enum in the product is drawn —
 * `STATUS_MAP` tone + glyph, so the portal is recognisably the same
 * product and a greyscale screenshot still separates the four. It is not
 * `<StatusBadge>` because that component resolves its own label from
 * `states.<domain>.<value>` and the heading needs the label at heading
 * weight beside its glyph, not inside a chip.
 */
function CategoryChip({ category, label }: { category: PortalTaskCategory; label: string }) {
  const spec = STATUS_MAP.portalTaskCategory[category];
  return (
    <span
      data-slot="portal-category"
      data-value={category}
      className={cn(
        "inline-flex h-5 w-fit items-center gap-1 rounded-full px-2 text-2xs whitespace-nowrap",
        TONE_CHIP[spec.tone],
      )}
    >
      <StatusIcon name={spec.icon} className="size-3 shrink-0" />
      <span>{label}</span>
    </span>
  );
}
