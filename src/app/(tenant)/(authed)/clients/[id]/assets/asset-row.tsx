"use client";

import {
  AppWindowIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  BadgeCheckIcon,
  BoxIcon,
  ExternalLinkIcon,
  GlobeIcon,
  type LucideIcon,
  MailIcon,
  NetworkIcon,
  PlugIcon,
  ServerIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { AutoForm } from "@/components/auto-form";
import { InlineEdit, RowActions, type RowAction } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRun } from "@/components/use-run";
import { withCurrentOption } from "@/lib/inline-edit";
import type { AssetType } from "@/modules/vault";

import { deleteAssetAction, setAssetStatusAction, updateAssetAction } from "./actions";
import {
  assetFieldLabelKey,
  assetFieldText,
  DAY_MAX,
  DAY_MIN,
  expiryCue,
  type AssetFieldsByType,
  type AssetItem,
} from "./asset-shape";

/** What the member may do with a row (the client loader's `asset:*` caps). */
export type AssetRowAbilities = { readonly manage: boolean; readonly delete: boolean };

const ICON: Record<AssetType, LucideIcon> = {
  DOMAIN: GlobeIcon,
  HOSTING: ServerIcon,
  DNS_ZONE: NetworkIcon,
  SSL_CERT: ShieldCheckIcon,
  EMAIL: MailIcon,
  CMS_APP: AppWindowIcon,
  THIRD_PARTY_SERVICE: PlugIcon,
  LICENSE: BadgeCheckIcon,
  CUSTOM: BoxIcon,
};

/**
 * ONE ASSET, read-first (FOUNDER MANDATE 1): every value is text until
 * edited, saved on blur through the row's `<AutoForm>`; its verbs — retire,
 * bring back, delete — live in the row's menu (MANDATE 2). The renewal cue
 * beside the name ("Expires in 12 days") is computed on the server from the
 * member's today, so it is the same text the server rendered.
 *
 * A REFUSED SAVE PUTS THE ROW BACK (slice 87's reviews): the row posts all
 * of its fields on every save, so a value the service refused, left in its
 * field's hidden input, would fail every later save of the row too while
 * the field at rest showed the old value. So a refusal is toasted (AutoForm)
 * and every value at rest is reseeded to the server's (`resetKey`): the
 * row is never poisoned, and the toast says the save failed — explicit,
 * never a silent revert (AGENTS.md). The refused TEXT is not kept: holding
 * refused fields open (`invalid`) was tried and, in a row of many fields,
 * made focus traps and stuck rows across three review rounds; the one
 * field a member just typed is cheap to type again.
 *
 * Retiring is not dangerous — the record stays and can come back — so it
 * acts on one click (a `confirm` on a non-danger item is dead string,
 * AGENTS.md); deleting is, and asks.
 */
export function AssetRow({
  clientId,
  item,
  can,
  types,
  fieldsByType,
  currencies,
  defaultCurrency,
  showProject,
}: {
  clientId: string;
  item: AssetItem;
  can: AssetRowAbilities;
  types: readonly AssetType[];
  fieldsByType: AssetFieldsByType;
  currencies: readonly string[];
  defaultCurrency: string;
  showProject: boolean;
}) {
  const t = useTranslations("assets");
  const tCommon = useTranslations("common");
  const { run } = useRun();
  const Icon = ICON[item.type];
  const cue = expiryCue(item.status, item.daysLeft);
  const readOnly = !can.manage;

  // Bumped on every refused save: each value at rest goes back to the
  // server's (see above). A control the member is still typing in keeps
  // its text — InlineEdit applies a reset only once they leave it, and a
  // commit supersedes it.
  const [resetKey, setResetKey] = useState(0);
  /** What every editable value takes: the row's reset. */
  const track = () => ({ resetKey });

  const items: RowAction[] = [];
  if (can.manage) {
    items.push(
      item.status === "ACTIVE"
        ? {
            key: "retire",
            label: t("row.retire"),
            icon: ArchiveIcon,
            onSelect: () => run(() => setAssetStatusAction(clientId, item.id, "RETIRED")),
          }
        : {
            key: "reactivate",
            label: t("row.reactivate"),
            icon: ArchiveRestoreIcon,
            onSelect: () => run(() => setAssetStatusAction(clientId, item.id, "ACTIVE")),
          },
    );
  }
  if (can.delete) {
    items.push({
      key: "delete",
      label: t("row.delete"),
      icon: Trash2Icon,
      tone: "danger",
      confirm: t("row.deleteConfirm", { name: item.name }),
      onSelect: () => run(() => deleteAssetAction(clientId, item.id)),
    });
  }

  const autoRenewValue = item.autoRenew === null ? "" : item.autoRenew ? "yes" : "no";
  const autoRenewOptions = [
    { value: "", label: t("autoRenew.unknown") },
    { value: "yes", label: t("autoRenew.yes") },
    { value: "no", label: t("autoRenew.no") },
  ];

  /** One labelled property: a fixed-width label, the read-first value beside it. */
  const prop = (label: string, value: React.ReactNode, wide = false, key?: string) => (
    <div key={key} className={wide ? "flex min-w-0 items-start gap-2 sm:col-span-2" : "flex min-w-0 items-center gap-2"}>
      <dt className={wide ? "w-32 shrink-0 pt-1.5 text-xs text-muted-foreground" : "w-32 shrink-0 text-xs text-muted-foreground"}>{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-1">{value}</dd>
    </div>
  );

  const cueBadge =
    cue === "expired" ? (
      <Badge variant="danger" data-testid="asset-cue">
        {t("expiry.expired")}
      </Badge>
    ) : cue === "today" ? (
      <Badge variant={item.autoRenew ? "neutral" : "danger"} data-testid="asset-cue">
        {item.autoRenew ? t("expiry.renewsToday") : t("expiry.today")}
      </Badge>
    ) : cue === "soon" ? (
      <Badge variant={item.autoRenew ? "neutral" : "caution"} data-testid="asset-cue">
        {item.autoRenew ? t("expiry.renewsIn", { days: item.daysLeft ?? 0 }) : t("expiry.expiresIn", { days: item.daysLeft ?? 0 })}
      </Badge>
    ) : null;

  const body = (
    <>
      {/* The menu stays on the name's line: on a phone the name and its
          badges wrap, the trigger never does. */}
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <InlineEdit
            kind="text"
            name="name"
            value={item.name}
            label={t("row.name")}
            placeholder={item.name}
            readOnly={readOnly}
            density="table"
            fit
            inputProps={{ required: true, maxLength: 200 }}
            controlClassName="font-medium"
            display={<span className="font-medium">{item.name}</span>}
            {...track()}
          />
          <Badge variant="neutral">{t(`types.${item.type}`)}</Badge>
          {showProject && item.project ? (
            <Badge variant="outline" title={item.project.name}>
              {item.project.key}
            </Badge>
          ) : null}
          {item.status === "RETIRED" ? <Badge variant="quiet">{t("status.RETIRED")}</Badge> : null}
          {cueBadge}
        </div>
        {items.length > 0 ? <RowActions label={tCommon("actionsFor", { name: item.name })} items={items} /> : null}
      </div>
      <dl className="grid min-w-0 gap-x-4 gap-y-1 sm:grid-cols-2">
        {prop(
          t("row.type"),
          <InlineEdit
            kind="select"
            name="type"
            value={item.type}
            label={t("row.type")}
            placeholder={t(`types.${item.type}`)}
            options={types.map((k) => ({ value: k, label: t(`types.${k}`) }))}
            readOnly={readOnly}
            density="table"
            {...track()}
          />,
        )}
        {prop(
          t("row.provider"),
          <InlineEdit
            kind="text"
            name="provider"
            value={item.provider ?? ""}
            label={t("row.provider")}
            placeholder={tCommon("notSet")}
            readOnly={readOnly}
            density="table"
            inputProps={{ maxLength: 200, autoComplete: "off" }}
            {...track()}
          />,
        )}
        {prop(
          t("row.identifier"),
          <InlineEdit
            kind="text"
            name="identifier"
            value={item.identifier ?? ""}
            label={t("row.identifier")}
            placeholder={tCommon("notSet")}
            readOnly={readOnly}
            density="table"
            inputProps={{ maxLength: 255, autoComplete: "off", spellCheck: false }}
            {...track()}
          />,
        )}
        {prop(
          t("row.url"),
          <>
            <InlineEdit
              kind="text"
              name="url"
              value={item.url ?? ""}
              label={t("row.url")}
              placeholder={tCommon("notSet")}
              readOnly={readOnly}
              density="table"
              inputProps={{ maxLength: 2048, inputMode: "url", autoComplete: "off" }}
              className="min-w-0 flex-1"
              {...track()}
            />
            {item.url ? (
              <Button asChild variant="ghost" size="icon-sm">
                <a href={item.url} target="_blank" rel="noreferrer noopener" aria-label={t("row.openUrl", { name: item.name })}>
                  <ExternalLinkIcon />
                </a>
              </Button>
            ) : null}
          </>,
        )}
        {prop(
          t("row.expiresAt"),
          <InlineEdit
            kind="date"
            name="expiresAt"
            value={item.expiresOn ?? ""}
            label={t("row.expiresAt")}
            placeholder={tCommon("notSet")}
            display={item.expiresLabel ? <span className="num">{item.expiresLabel}</span> : undefined}
            readOnly={readOnly}
            density="table"
            inputProps={{ min: DAY_MIN, max: DAY_MAX }}
            {...track()}
          />,
        )}
        {prop(
          t("row.autoRenew"),
          <InlineEdit
            kind="select"
            name="autoRenew"
            value={autoRenewValue}
            label={t("row.autoRenew")}
            placeholder={t("autoRenew.unknown")}
            options={autoRenewOptions}
            readOnly={readOnly}
            density="table"
            {...track()}
          />,
        )}
        {prop(
          t("row.renewalCost"),
          <>
            {/* The amount, then its currency beside it ("1 200,00 SEK"). The
                currency is drawn only with a cost: alone it would be a
                pick the service drops (the two travel together), and a
                "Saved" for nothing (the code review). */}
            <InlineEdit
              kind="text"
              name="renewalCost"
              value={item.renewalCost ?? ""}
              label={t("row.renewalCost")}
              placeholder={tCommon("notSet")}
              display={
                item.amountLabel ? (
                  <span className="num">{readOnly && item.currency ? `${item.amountLabel} ${item.currency}` : item.amountLabel}</span>
                ) : undefined
              }
              readOnly={readOnly}
              density="table"
              fit
              inputProps={{ maxLength: 16, inputMode: "decimal", autoComplete: "off" }}
              {...track()}
            />
            {!readOnly && item.renewalCost !== null ? (
              <InlineEdit
                kind="select"
                name="currency"
                value={item.currency ?? defaultCurrency}
                label={t("row.currency")}
                placeholder={item.currency ?? defaultCurrency}
                // A stored currency outside the offered six (an import's
                // CHF) stays a choice — else the select opens on another
                // and the row's every save would rewrite it (the fix-pass review).
                options={withCurrentOption(
                  currencies.map((c) => ({ value: c, label: c })),
                  item.currency ?? "",
                  item.currency,
                )}
                density="table"
                fit
                {...track()}
              />
            ) : null}
          </>,
        )}
        {fieldsByType[item.type].map(({ key, kind }) =>
          prop(
            t(assetFieldLabelKey(key)),
            <InlineEdit
              kind="text"
              name={`field.${key}`}
              value={assetFieldText(item.fields[key])}
              label={t(assetFieldLabelKey(key))}
              placeholder={tCommon("notSet")}
              readOnly={readOnly}
              density="table"
              inputProps={{
                autoComplete: "off",
                spellCheck: false,
                ...(kind === "count" ? { inputMode: "numeric" as const } : {}),
              }}
              {...track()}
            />,
            false,
            key,
          ),
        )}
        {can.manage || item.notes
          ? prop(
              t("row.notes"),
              <InlineEdit
                kind="multiline"
                name="notes"
                value={item.notes ?? ""}
                label={t("row.notes")}
                placeholder={t("row.addNote")}
                readOnly={readOnly}
                density="table"
                className="min-w-0 flex-1"
                {...track()}
              />,
              true,
            )
          : null}
      </dl>
    </>
  );

  return (
    <li id={`asset-${item.id}`} className="scroll-mt-16 px-3 py-3" data-testid="asset-item" data-name={item.name} data-asset-id={item.id}>
      {readOnly ? (
        <div className="flex flex-col gap-2">{body}</div>
      ) : (
        <AutoForm
          action={updateAssetAction}
          className="flex flex-col gap-2"
          onError={() => setResetKey((k) => k + 1)}
        >
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="assetId" value={item.id} />
          {body}
        </AutoForm>
      )}
    </li>
  );
}
