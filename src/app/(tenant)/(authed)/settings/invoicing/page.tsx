import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { enrolUrl } from "@/authz/redirects";
import { Callout, EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { requireTenantContext } from "@/members/tenant-context";
import { readBookkeepingSettingsPage, readInvoiceSettings, type BookkeepingSettingsPage, type InvoiceSettings } from "@/modules/invoicing";

import { BookkeepingCard } from "./bookkeeping-card";
import { CompanyCard } from "./company-card";
import { NumberingCard } from "./numbering-card";
import { PaymentCard } from "./payment-card";
import { TermsCard } from "./terms-card";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.invoicing");
  return { title: t("title") };
}

const changedOf = (c: InvoiceSettings["companyChanged"]) => (c ? { by: c.by, at: c.at.toISOString() } : null);

/**
 * /settings/invoicing (Phase 4 slice 107; founder decision C75) — what the
 * workspace's invoices say about it: the company (legal name, org. number,
 * VAT number, registered office, F-tax, address) and how clients pay (bank
 * details and the note printed on every invoice) — both changed only with the
 * member's authenticator code typed in the form, every owner mailed (C75
 * (h)–(j)) — the invoice numbers' first number (slice 108, C76 (b); owners,
 * `invoice:manage_series` ✦), the default payment terms, and how the
 * bookkeeping file books (slice 111, C82 — the method, the financial year,
 * the series, the accounts). `settings:view`
 * reads it, `settings:edit` changes it; the invoicing module closes it. A
 * caution says what issuing still needs.
 */
export default async function InvoicingSettingsPage() {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("settings.invoicing");
  const tCommon = await getTranslations("common");

  let settings: InvoiceSettings | null = null;
  try {
    settings = await readInvoiceSettings({ tenantId: membership.tenantId, actor });
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  if (!settings) {
    return (
      <Page width="form">
        <PageHeader title={t("title")} />
        <div className="mt-6">
          <SectionCard>
            <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={t("noPermission")} />
          </SectionCard>
        </div>
      </Page>
    );
  }

  // Slice 111 (C82): the bookkeeping file's method, year and accounts — read
  // after the page's own gates, under the same two codes.
  const bookkeeping: BookkeepingSettingsPage = await readBookkeepingSettingsPage({ tenantId: membership.tenantId, actor });
  const { company, payment, missing, canEdit } = settings;
  const hasFactor = actor.mfa?.enrolled === true;
  // The enrolment notice, and back here after (the action's own redirect keeps the same way back).
  const enrolHref = enrolUrl("/settings/invoicing");
  return (
    <Page width="form">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="mt-6 flex flex-col gap-4">
        {missing.length > 0 ? (
          <div data-testid="invoice-missing">
            <Callout tone="caution" title={t("missing.title")}>
              {t("missing.body", { list: missing.map((m) => t(`missing.items.${m}`)).join(", ") })}
            </Callout>
          </div>
        ) : null}
        <SectionCard title={t("company.title")} description={t("company.description")}>
          <CompanyCard values={company} editable={canEdit} hasFactor={hasFactor} changed={changedOf(settings.companyChanged)} enrolHref={enrolHref} />
        </SectionCard>
        <SectionCard title={t("payment.title")} description={t("payment.description")}>
          <PaymentCard values={payment} editable={canEdit} hasFactor={hasFactor} changed={changedOf(settings.paymentChanged)} enrolHref={enrolHref} />
        </SectionCard>
        <SectionCard title={t("numbering.title")} description={t("numbering.description")}>
          <NumberingCard
            firstNumber={settings.numbering?.firstNumber ?? null}
            nextNumber={settings.numbering?.nextNumber ?? null}
            used={settings.numbering?.used ?? false}
            editable={settings.canManageNumbering}
          />
        </SectionCard>
        <SectionCard title={t("terms.title")}>
          <TermsCard days={settings.paymentTermsDays} editable={canEdit} />
        </SectionCard>
        <SectionCard id="bookkeeping" title={t("bookkeeping.title")} description={t("bookkeeping.description")}>
          <BookkeepingCard values={bookkeeping.values} editable={bookkeeping.canEdit} methodFixed={bookkeeping.methodFixed} />
        </SectionCard>
      </div>
    </Page>
  );
}
