import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { Callout, Page, PageHeader, SectionCard } from "@/components/semantic";
import { requireTenantContext } from "@/members/tenant-context";
import { getSealedAsk, type SealedAskView } from "@/modules/vault";

import { AnswerControls } from "./answer-controls";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("vault.requests");
  return { title: t("metaTitle") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/vault/requests/[id]` — A CLIENT'S ASK TO OPEN THE LOGINS THE AGENCY
 * KEEPS SEALED FOR THEM (Phase 3V slice 93; founder decisions C52 (f)–(h),
 * C61). Where every answerer's mail lands (C61 (b): the mail's buttons open
 * the ask here, signed in). Who asked, why, when, how many logins are
 * sealed for the client (a count — never which, C54), where it stands, and
 * — until the moment it opens (C61 (c)) — Approve (the authenticator code,
 * every time) and Deny (no code, an optional reason the client is shown).
 *
 * For members who hold `credential:unseal` (owners by default; C61 (f))
 * and whose scope reaches the client; anyone else gets a 404 (UI.md §7.3).
 * NOT behind the vault's door: nothing here names a login or holds a
 * secret, and a member arriving from the mail can deny without stepping up.
 */
export default async function SealedRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { membership, actor } = await requireTenantContext();
  let view: SealedAskView;
  try {
    view = await getSealedAsk({ tenantId: membership.tenantId, actor }, id);
  } catch (e) {
    if (e instanceof AuthzError) notFound();
    throw e;
  }
  const t = await getTranslations("vault.requests");
  const format = await getFormatter();
  const when = (d: Date) =>
    format.dateTime(d, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  const s = view.state;
  const answeredBy = view.answer?.by ?? t("someone");
  let where: string;
  switch (s.kind) {
    case "waiting":
      where = t("state.waiting", { date: when(s.confirmableAt) });
      break;
    case "confirmable":
      where = t("state.confirmable", { date: when(s.lapsesAt) });
      break;
    case "opening":
      where = t("state.opening", { date: when(s.opensAt), name: view.confirmedBy ?? t("theClient") });
      break;
    case "open":
      where = t("state.open", { date: when(s.openUntil) });
      break;
    case "closed":
      where = t("state.closed", { date: when(s.closedAt) });
      break;
    case "denied":
      where = t("state.denied", { date: when(s.deniedAt), name: answeredBy });
      break;
    case "withdrawn":
      where = t("state.withdrawn", { date: when(s.withdrawnAt), name: view.withdrawnBy ?? t("theClient") });
      break;
    case "lapsed":
      where = t("state.lapsed", { date: when(s.lapsedAt) });
      break;
  }
  const answerable = view.can.approve || view.can.deny;

  return (
    <Page width="form">
      <PageHeader title={t("title", { client: view.client.name })} description={t("description")} />
      <div className="mt-6 flex flex-col gap-4" data-testid="sealed-request" data-state={s.kind}>
        <Callout tone={answerable || s.kind === "open" ? "caution" : "info"} role="status">
          {where}
          {view.answer?.kind === "approved" ? ` ${t("approvedBy", { name: answeredBy, date: when(view.answer.at) })}` : null}
        </Callout>

        <SectionCard title={t("askTitle")}>
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t("client")}</dt>
            <dd>
              <Link
                href={`/clients/${view.client.id}/vault`}
                className="rounded-sm text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {view.client.name}
              </Link>
            </dd>
            <dt className="text-muted-foreground">{t("askedBy")}</dt>
            <dd className="text-foreground">
              {view.askedBy ? t("contact", { name: view.askedBy.name, email: view.askedBy.email }) : t("goneContact")}
            </dd>
            <dt className="text-muted-foreground">{t("askedOn")}</dt>
            <dd className="text-foreground">{when(view.askedAt)}</dd>
            <dt className="text-muted-foreground">{t("sealedCount")}</dt>
            <dd className="text-foreground">{t("sealedCountValue", { count: view.sealedCount })}</dd>
            <dt className="text-muted-foreground">{t("wait")}</dt>
            <dd className="text-foreground">{t("waitValue", { days: view.waitDays })}</dd>
          </dl>
          <div className="mt-4 flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">{t("reason")}</p>
            <blockquote className="border-l-2 border-border pl-3 text-sm whitespace-pre-line text-foreground" data-testid="sealed-request-reason">
              {view.reason}
            </blockquote>
          </div>
          {view.answer?.kind === "denied" && view.answer.reason ? (
            <div className="mt-4 flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">{t("denyReasonShown")}</p>
              <blockquote className="border-l-2 border-border pl-3 text-sm whitespace-pre-line text-foreground">
                {view.answer.reason}
              </blockquote>
            </div>
          ) : null}
        </SectionCard>

        {/* Always drawn: it keeps its dialogs mounted across the answer's
            revalidation, and draws the Answer card only while there is one. */}
        <AnswerControls requestId={view.id} canApprove={view.can.approve} canDeny={view.can.deny} />
      </div>
    </Page>
  );
}
