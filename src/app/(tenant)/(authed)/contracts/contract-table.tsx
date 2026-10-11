import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { DataTable } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ContractListRow } from "@/modules/contracts";

/**
 * The contracts table — `/contracts` (every client) and the client page's
 * Contracts tab (one client: `showClient` false). One table, so the two lists
 * cannot drift apart (UI.md §12). A contract signed elsewhere (slice 112c)
 * carries a "Signed elsewhere" mark beside its status.
 */
export function ContractTable({ rows, showClient, label }: { rows: readonly ContractListRow[]; showClient: boolean; label: string }) {
  const t = useTranslations("contracts.list");
  const tStatus = useTranslations("contracts.status");
  const tUploaded = useTranslations("contracts.uploaded");
  const format = useFormatter();
  return (
    <DataTable flush scrollLabel={label}>
      <Table data-testid="contract-list">
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns.title")}</TableHead>
            {showClient ? <TableHead priority="medium">{t("columns.client")}</TableHead> : null}
            <TableHead>{t("columns.status")}</TableHead>
            <TableHead priority="low" className="w-[8ch]">
              {t("columns.version")}
            </TableHead>
            {/* When it ends — what matters most about a signed one (C86 (c)). */}
            <TableHead priority="medium">{t("columnEnds")}</TableHead>
            <TableHead priority="low">{t("columns.updated")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id} data-testid="contract-row" data-contract-id={r.id} data-status={r.status} data-origin={r.origin}>
              {/* The title YIELDS (`contain-inline-size`): a long one never widens the card. */}
              <TableCell className="min-w-24">
                <div className="flex w-full min-w-0 contain-inline-size">
                  <Link
                    href={`/contracts/${r.id}`}
                    title={r.title}
                    className="min-w-0 truncate rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {r.title}
                  </Link>
                </div>
              </TableCell>
              {showClient ? (
                <TableCell priority="medium" className="max-w-48 truncate text-muted-foreground">
                  {r.client.name}
                </TableCell>
              ) : null}
              <TableCell className="whitespace-nowrap">
                <span className="inline-flex items-center gap-1.5">
                  <Badge variant={r.status === "DRAFT" ? "neutral" : "brand"}>{tStatus(r.status)}</Badge>
                  {r.origin === "UPLOADED" ? <Badge variant="neutral">{tUploaded("badge")}</Badge> : null}
                </span>
              </TableCell>
              <TableCell priority="low" className="num whitespace-nowrap text-muted-foreground">
                {r.origin === "WRITTEN" ? t("versionValue", { version: r.version }) : t("none")}
              </TableCell>
              <TableCell priority="medium" className="num whitespace-nowrap text-muted-foreground" data-testid="contract-row-ends">
                {/* A stored day (UTC midnight), formatted in UTC so no zone shifts it. */}
                {r.endsOn ? format.dateTime(new Date(`${r.endsOn}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }) : t("none")}
              </TableCell>
              <TableCell priority="low" className="num whitespace-nowrap text-muted-foreground">
                {format.dateTime(r.updatedAt, { dateStyle: "medium" })}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTable>
  );
}
