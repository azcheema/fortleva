import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { Callout } from "@/components/semantic";
import { requireTenantContext } from "@/members/tenant-context";
import { listLiveSealedAsks } from "@/modules/vault";

/**
 * CLIENTS ASKING TO OPEN THEIR SEALED LOGINS (Phase 3V slice 93; C52 (f),
 * C61) — over `/vault`, for the members who may answer (`credential:unseal`,
 * their scope): every ask still in play, each a link to its page. Drawn
 * whether or not the vault is open — it names no login and holds no
 * secret, only a client and where its ask stands — and nothing at all for
 * anyone else (the read is quiet). The mail is the first word; this is
 * where a member who missed it finds the ask.
 */
export async function SealedAsksBanner() {
  const { membership, actor } = await requireTenantContext();
  const asks = await listLiveSealedAsks({ tenantId: membership.tenantId, actor });
  if (asks.length === 0) return null;
  const t = await getTranslations("vault.requests");
  const format = await getFormatter();
  const when = (d: Date) => format.dateTime(d, { year: "numeric", month: "short", day: "numeric" });
  const lineOf = (s: (typeof asks)[number]["state"]): string => {
    switch (s.kind) {
      case "waiting":
        return t("banner.waiting", { date: when(s.confirmableAt) });
      case "confirmable":
        return t("banner.confirmable");
      case "opening":
        return t("banner.opening", { date: when(s.opensAt) });
      case "open":
        return t("banner.open", { date: when(s.openUntil) });
      default:
        return "";
    }
  };
  return (
    <div data-testid="sealed-asks-banner">
      <Callout tone="caution" role="status" title={t("banner.title", { count: asks.length })}>
        <ul className="flex flex-col gap-1">
          {asks.map((a) => (
            <li key={a.id} className="flex flex-wrap gap-x-1.5">
              <Link
                href={`/vault/requests/${a.id}`}
                className="rounded-sm font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {a.client.name}
              </Link>
              <span>{lineOf(a.state)}</span>
            </li>
          ))}
        </ul>
      </Callout>
    </div>
  );
}
