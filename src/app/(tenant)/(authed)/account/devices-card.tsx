import { MonitorIcon, SmartphoneIcon, TabletIcon } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import type { DeviceRow } from "@/auth/account-security";
import { SectionCard } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";

import { SignOutDevice, SignOutOthers } from "./device-actions";

const KIND_ICON = { desktop: MonitorIcon, mobile: SmartphoneIcon, tablet: TabletIcon } as const;

/**
 * "YOUR DEVICES" (slice 84, founder decision C50): where this account is
 * signed in, so a member who has lost a device — or sees one they do not
 * recognise — can sign it out.
 *
 * A SERVER component: every date is formatted here, in the request's zone,
 * and only the two verbs are client islands — so nothing can render one
 * day on the server and another in the browser (the hydration trap a
 * client-side "2 hours ago" would set).
 *
 * Each row: what the browser says it is, the network it signed in from
 * (`networkOf` — a place name would need a geolocation database the
 * product does not ship), when it signed in and when it was last active.
 * This device first, marked, with no sign-out of its own: the account
 * menu's sign-out is that.
 */
export async function DevicesCard({ devices, now }: { devices: readonly DeviceRow[]; now: Date }) {
  const t = await getTranslations("account.devices");
  const format = await getFormatter();
  const others = devices.filter((d) => !d.current).length;

  const nameOf = (d: DeviceRow): string =>
    d.browser && d.os
      ? t("browserOn", { browser: d.browser, os: d.os })
      : (d.browser ?? d.os ?? t("unknownDevice"));

  return (
    <SectionCard
      title={t("title")}
      description={t("description")}
      actions={others > 0 ? <SignOutOthers /> : null}
      contentClassName="p-0"
    >
      <ul className="divide-y divide-border" data-testid="devices">
        {devices.map((d) => {
          const Icon = KIND_ICON[d.kind];
          const name = nameOf(d);
          // This device is in use as the page is read; its row's last
          // write can be a day old (`DeviceRow.lastActiveAt`).
          const facts = {
            signedIn: format.dateTime(d.signedInAt, { dateStyle: "medium" }),
            active: d.current ? t("activeNow") : format.relativeTime(d.lastActiveAt, now),
          };
          return (
            <li key={d.id} className="flex items-center gap-3 px-4 py-3" data-testid="device" data-current={d.current || undefined}>
              <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{name}</span>
                  {d.current ? <Badge variant="success">{t("thisDevice")}</Badge> : null}
                  {d.console ? <Badge variant="outline">{t("console")}</Badge> : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {d.network ? t("detailsWithNetwork", { network: d.network, ...facts }) : t("details", facts)}
                </span>
              </div>
              {d.current ? null : <SignOutDevice sessionId={d.id} label={name} />}
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
