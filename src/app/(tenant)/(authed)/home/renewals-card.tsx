import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import type { ExpirationsGlance } from "@/modules/vault";

import { ExpirationList } from "../expirations/expiration-list";

/**
 * `/home`'s renewals card (Phase 3V slice 88; PLAN Phase 3V's Home
 * "Expiring soon" widget): what is past its date or due within 30 days —
 * assets and, for a member who may see them, agreements — soonest first,
 * at most five rows, each one link to where it is renewed; "All renewals"
 * opens `/expirations`. Logins are not on it (C54 keeps them to a count,
 * on the page).
 *
 * DRAWN ONLY WHEN THERE IS A ROW TO DRAW — the other Home cards' rule: a
 * card saying "nothing to renew" spends the first phone screen restating
 * an absence. `null` from the glance (no `asset:view`, or the vault module
 * off) draws nothing either.
 */
export async function RenewalsCard({ glance, today }: { glance: ExpirationsGlance; today: string }) {
  const t = await getTranslations("expirations.card");
  return (
    <SectionCard
      title={t("title")}
      description={t("description")}
      actions={
        <Button asChild size="sm" variant="outline">
          <Link href="/expirations">{t("all")}</Link>
        </Button>
      }
      contentClassName="p-0"
    >
      <ExpirationList entries={glance.entries} today={today} testId="home-renewals" />
      {glance.more > 0 ? (
        <p className="border-t border-border px-4 py-2.5 text-sm text-muted-foreground">
          {glance.moreAtLeast ? t("moreAtLeast", { count: glance.more }) : t("more", { count: glance.more })}
        </p>
      ) : null}
    </SectionCard>
  );
}
