import { useTranslations } from "next-intl";

import { DataTable } from "@/components/semantic";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/format";
import type { ReportSnapshot } from "@/modules/time";

/**
 * THE LINES OF A TIME REPORT, drawn once for both planes.
 *
 * The member's Reports tab previews a snapshot with this table before
 * publishing it, and the portal draws a PUBLISHED one with the same
 * table — so "the client will see exactly this snapshot" (the publish
 * confirmation's promise) is true of the RENDERING as well as the
 * bytes. One component, two consumers, the way `UpdateView` is shared
 * between the composer's preview and the portal's card.
 *
 * Nothing here reaches for a request context: the duration style and
 * the locale come in as props, because the member's is a preference and
 * the portal's is fixed. No directive either, so a client component
 * (the member panel) and a server component (the portal section) can
 * both import it.
 *
 * A line's label is the snapshot's own: a task's key and title, an
 * epic's, an agreement's name, a day — or, for `other`, the one string
 * this component localises, because the generator folded every INTERNAL
 * name into it and stored no label on purpose (DATA_MODEL §6.15 D3).
 */
export function ReportSnapshotTable({
  snapshot,
  fmt,
  locale,
  scrollLabel,
}: {
  snapshot: ReportSnapshot;
  /** Seconds → text, in the reader's duration style. */
  fmt: (seconds: number) => string;
  locale: string;
  /** Names the scroll region, from t(). */
  scrollLabel: string;
}) {
  const t = useTranslations("timeReports.snapshot");
  const s = snapshot;
  const money = (a: string | undefined) => (a !== undefined && s.currency ? formatMoney(locale, Number(a), s.currency) : null);
  const label = (l: ReportSnapshot["lines"][number]): string => {
    switch (l.kind) {
      case "day":
        return l.date;
      case "work_item":
      case "epic":
        return `${l.ref} ${l.label}`;
      case "service":
        return l.label;
      case "other":
        return t("other");
    }
  };
  return (
    <DataTable flush density="compact" scrollLabel={scrollLabel}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("line")}</TableHead>
            <TableHead className="w-[10ch] text-right">{t("hours")}</TableHead>
            <TableHead priority="medium" className="w-[10ch] text-right">
              {t("billable")}
            </TableHead>
            {s.includeAmounts ? (
              <TableHead priority="low" className="w-[14ch] text-right">
                {t("amount")}
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {s.lines.map((l, i) => (
            <TableRow key={i} data-slot="report-line" data-kind={l.kind}>
              <TableCell className={l.kind === "other" ? "text-muted-foreground" : undefined}>{label(l)}</TableCell>
              <TableCell className="num text-right">{fmt(l.seconds)}</TableCell>
              <TableCell priority="medium" className="num text-right text-muted-foreground">
                {fmt(l.billableSeconds)}
              </TableCell>
              {s.includeAmounts ? (
                <TableCell priority="low" className="num text-right">
                  {money(l.amount) ?? "—"}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
          <TableRow className="bg-muted/40" data-slot="report-total">
            <TableCell className="font-semibold">{t("total")}</TableCell>
            <TableCell className="num text-right font-semibold">{fmt(s.totals.seconds)}</TableCell>
            <TableCell priority="medium" className="num text-right">
              {fmt(s.totals.billableSeconds)}
            </TableCell>
            {s.includeAmounts ? (
              <TableCell priority="low" className="num text-right font-semibold">
                {money(s.totals.amount) ?? "—"}
              </TableCell>
            ) : null}
          </TableRow>
        </TableBody>
      </Table>
    </DataTable>
  );
}
