import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { Callout, DataTable, SectionCard } from "@/components/semantic";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HOURS_PAGE_ROWS_MAX, printedTask, printHoursMinutes, printQuantity, type HoursPagePrint } from "@/modules/invoicing";

/** At most this many rows on the card; the PDF has every one. */
const CARD_ROWS_MAX = 300;

/**
 * THE TIME BREAKDOWN AS THE CLIENT SEES IT (Phase 4 slice 110b; C80 (d),
 * C81) — on a ticked draft, the page the database would freeze if it were
 * issued now (the guard's own function); on an issued invoice, the page as
 * frozen. Per invoice line: its text, each day's hours by task ("Other work"
 * for every task the client may not see), and the total with its decimal
 * hours. Never a person or a note — the PDF's rows and titles exactly (a
 * long title shortened as the PDF shortens it), which is why it is the
 * member's check before issuing; its words, dates and numbers are in the
 * member's language, the PDF's in the invoice's.
 */
export async function HoursPageCard({ page, draft }: { page: HoursPagePrint; draft: boolean }) {
  const t = await getTranslations("invoices.hoursPage");
  const format = await getFormatter();
  const locale = await getLocale();
  const numbers = locale.startsWith("sv") ? "sv" : "en";
  const hm = (seconds: number) => printHoursMinutes(seconds, page.withSeconds);

  const { lines, hidden } = capRows(page, CARD_ROWS_MAX);
  const rows = page.lines.reduce((n, l) => n + l.rows.length, 0);

  return (
    <SectionCard title={t("title")} description={draft ? t("descriptionDraft") : t("descriptionIssued")} contentClassName="p-0">
      <div data-testid="hours-page">
        {/* Past the rows a PDF can carry the issue is refused (the design review's M2). */}
        {draft && rows > HOURS_PAGE_ROWS_MAX ? (
          <div className="p-3" data-testid="hours-page-too-long">
            <Callout tone="caution">{t("tooLong", { max: HOURS_PAGE_ROWS_MAX })}</Callout>
          </div>
        ) : null}
        <DataTable flush scrollLabel={t("title")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[14ch]">{t("columns.date")}</TableHead>
                <TableHead>{t("columns.work")}</TableHead>
                <TableHead className="w-[16ch] text-right">{t("columns.hours")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => (
                <HoursPageLineRows
                  key={line.lineId}
                  description={line.description}
                  rows={line.shown.map((r, i) => ({
                    key: `${r.date}:${i}`,
                    date: format.dateTime(new Date(`${r.date}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }),
                    work: r.task === null ? t("otherWork") : printedTask(r.task),
                    other: r.task === null,
                    hours: hm(r.seconds),
                  }))}
                  totalLabel={t("total")}
                  total={t("totalValue", { hm: hm(line.seconds), hours: printQuantity(line.quantity, numbers) })}
                />
              ))}
            </TableBody>
          </Table>
        </DataTable>
        {hidden > 0 || page.withSeconds ? (
          <div className="flex flex-col gap-1 border-t border-border p-3 text-xs text-muted-foreground">
            {hidden > 0 ? <p>{t("more", { count: hidden })}</p> : null}
            {/* A project that does not round bills raw seconds: the page prints them so it adds up (C81 (b)). */}
            {page.withSeconds ? <p data-testid="hours-page-seconds">{t("withSeconds")}</p> : null}
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}

/** The page's first `max` rows, line by line, and how many were left out. */
function capRows(page: HoursPagePrint, max: number) {
  let budget = max;
  let hidden = 0;
  const lines = [];
  for (const line of page.lines) {
    const shown = line.rows.slice(0, Math.max(0, budget));
    budget -= shown.length;
    hidden += line.rows.length - shown.length;
    // A line none of whose rows fit is not drawn as a heading and a total alone.
    if (shown.length > 0) lines.push({ ...line, shown });
  }
  return { lines, hidden };
}

function HoursPageLineRows({
  description,
  rows,
  totalLabel,
  total,
}: {
  description: string;
  rows: readonly { key: string; date: string; work: string; other: boolean; hours: string }[];
  totalLabel: string;
  total: string;
}) {
  return (
    <>
      <TableRow data-testid="hours-page-line">
        <TableCell colSpan={3} className="font-medium">
          <div className="w-full min-w-0 truncate contain-inline-size" title={description}>
            {description}
          </div>
        </TableCell>
      </TableRow>
      {rows.map((r) => (
        <TableRow key={r.key} data-testid="hours-page-row">
          <TableCell className="num whitespace-nowrap text-muted-foreground">{r.date}</TableCell>
          <TableCell className={r.other ? "text-muted-foreground" : undefined}>
            <div className="w-full min-w-0 truncate contain-inline-size" title={r.work}>
              {r.work}
            </div>
          </TableCell>
          <TableCell className="num text-right whitespace-nowrap">{r.hours}</TableCell>
        </TableRow>
      ))}
      <TableRow data-testid="hours-page-total">
        <TableCell colSpan={2} className="text-muted-foreground">
          {totalLabel}
        </TableCell>
        <TableCell className="num text-right font-medium whitespace-nowrap">{total}</TableCell>
      </TableRow>
    </>
  );
}
