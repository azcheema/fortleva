import { DownloadIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";

import { RichText } from "@/components/rich-text/render";
import { Callout, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { isUuid } from "@/db/context";
import { readPortalContract, type PortalContractDetail, type PortalSignature } from "@/modules/contracts/portal";
import { portalReadOrNull } from "@/portal";
import { requirePortalContext } from "@/portal/context";

import { PortalFrame } from "../../portal-frame";
import { downloadContractAction } from "../actions";
import { ContractStateBadge } from "../state-badge";
import { OUTCOME_ID } from "./outcome-id";
import { OutcomeFocus, SignCard } from "./sign-card";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal.contracts");
  return { title: t("title") };
}

const LINK =
  "rounded-sm text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * `/portal/contracts/[id]` — ONE SENT CONTRACT (Phase 4 slice 112b2; founder
 * decisions C84, C85): where it stands; while it waits for THIS person, the
 * Sign card (tick, full name, Sign — or Decline…); its dates and parties; the
 * text, as frozen at sending; both signatures by name, and the reason when the
 * client declined; the PDF as sent and, once signed, the signed copy (C85 (b):
 * the client's copy is here); the fingerprint both signatures attest to.
 *
 * The projection reads under the contact (`readPortalContract`); the PDFs come
 * from the broker (`../actions.ts`). Anything refused is a 404 — on this plane
 * a reason is a fact about the agency.
 */
export default async function PortalContractPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  if (!isUuid(id)) notFound();
  const { principal, name } = await requirePortalContext();
  const t = await getTranslations("portal.contracts");
  const tDomain = await getTranslations("domainErrors");
  const format = await getFormatter();
  const contract = await portalReadOrNull("readPortalContract", () => readPortalContract(principal, id));
  if (!contract) notFound();
  // A stored `@db.Date` (UTC midnight), formatted in UTC so no zone shifts the day.
  const day = (iso: string) => format.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
  const moment = (d: Date) => format.dateTime(d, { dateStyle: "medium", timeStyle: "short" });
  const refusal = error === "rate" ? tDomain("DOWNLOAD_RATE_LIMITED") : error ? t("errors.download") : null;
  const client = contract.signatures.find((s) => s.party === "CLIENT") ?? null;

  return (
    <PortalFrame name={name} principal={principal} nav="contracts">
      <Page>
        <div className="flex flex-col gap-6">
          <PageHeader
            title={contract.title}
            breadcrumb={
              <Link href="/portal/contracts" prefetch={false} className={LINK}>
                {t("back")}
              </Link>
            }
            badges={<ContractStateBadge status={contract.status} waitingForYou={contract.waitingForYou} />}
          />
          {refusal ? (
            <div data-testid="portal-contract-error">
              <Callout tone="danger" role="alert">
                {refusal}
              </Callout>
            </div>
          ) : null}

          {contract.canSign ? (
            <SectionCard title={t("sign.title")} description={t("sign.description")}>
              <SignCard contractId={contract.id} />
            </SectionCard>
          ) : (
            // Focusable for the moment the Sign card it replaces disappears
            // under the reader (`OutcomeFocus`).
            <div id={OUTCOME_ID} tabIndex={-1} data-testid="portal-contract-outcome" className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              <OutcomeFocus contractId={contract.id} />
              <Outcome contract={contract} client={client} t={t} day={day} />
            </div>
          )}

          <SectionCard title={t("facts")}>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2" data-testid="portal-contract-facts">
              <Fact label={t("versionLabel")} value={String(contract.version)} />
              <Fact label={t("sent")} value={moment(contract.sentAt)} />
              {contract.signedOn ? <Fact label={t("signed")} value={day(contract.signedOn)} /> : null}
              {contract.startsOn ? <Fact label={t("starts")} value={day(contract.startsOn)} /> : null}
              {contract.endsOn ? <Fact label={t("ends")} value={day(contract.endsOn)} /> : null}
            </dl>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {/* Form posts, never links — each download is audited and its link minted on the way. */}
              {contract.signedCopyReady ? <Download contractId={contract.id} kind="signed" label={t("downloadSigned")} /> : null}
              {contract.pdfReady ? (
                <Download contractId={contract.id} kind="sent" label={t("download")} variant={contract.signedCopyReady ? "outline" : "default"} />
              ) : null}
              {contract.status === "SIGNED" && !contract.signedCopyReady ? (
                <p className="text-xs text-muted-foreground" data-testid="portal-contract-preparing">
                  {t("signedCopyPreparing")}
                </p>
              ) : !contract.pdfReady ? (
                <p className="text-xs text-muted-foreground" data-testid="portal-contract-preparing">
                  {t("pdfPreparing")}
                </p>
              ) : null}
            </div>
          </SectionCard>

          {contract.parties ? (
            <SectionCard title={t("parties")}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="portal-contract-parties">
                {(["agency", "client"] as const).map((side) => {
                  const party = contract.parties![side];
                  return (
                    <div key={side} className="flex min-w-0 flex-col gap-0.5 text-sm">
                      <span className="text-xs text-muted-foreground">{side === "agency" ? t("agency") : t("yourCompany")}</span>
                      <span className="font-medium break-words">{party.name}</span>
                      {party.orgNr ? <span className="num-id">{t("orgNr", { orgNr: party.orgNr })}</span> : null}
                      {party.address ? <span className="break-words text-muted-foreground">{party.address}</span> : null}
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          ) : null}

          <SectionCard title={t("text")}>
            <RichText doc={contract.body} data-testid="portal-contract-body" />
          </SectionCard>

          <SectionCard title={t("signatures")}>
            <ul className="flex flex-col gap-4" data-testid="portal-contract-signatures">
              {contract.signatures.map((s) => (
                <SignatureItem key={s.party} signature={s} t={t} moment={moment} />
              ))}
            </ul>
            {contract.contentSha256 ? (
              <div className="mt-4 flex flex-col gap-1 border-t border-border pt-4">
                <span className="text-xs text-muted-foreground">{t("fingerprint")}</span>
                <span className="num-id font-mono text-xs break-all" data-testid="portal-contract-fingerprint">
                  {contract.contentSha256}
                </span>
                <span className="text-xs text-muted-foreground">{t("fingerprintHint")}</span>
              </div>
            ) : null}
          </SectionCard>
        </div>
      </Page>
    </PortalFrame>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<"portal.contracts">>>;

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num text-sm">{value}</dd>
    </div>
  );
}

function Download({
  contractId,
  kind,
  label,
  variant = "default",
}: {
  contractId: string;
  kind: "sent" | "signed";
  label: string;
  variant?: "default" | "outline";
}) {
  return (
    <form action={downloadContractAction}>
      <input type="hidden" name="contractId" value={contractId} />
      <input type="hidden" name="kind" value={kind} />
      <Button type="submit" variant={variant} size="sm" data-testid={kind === "signed" ? "portal-contract-download-signed" : "portal-contract-download"}>
        <DownloadIcon aria-hidden="true" />
        {label}
      </Button>
    </form>
  );
}

/** Where the contract stands, for a reader who has nothing to do on it now. */
function Outcome({
  contract,
  client,
  t,
  day,
}: {
  contract: PortalContractDetail;
  client: PortalSignature | null;
  t: T;
  day: (iso: string) => string;
}) {
  switch (contract.status) {
    case "SENT":
      return <Callout tone="info">{client ? t("outcome.waitingFor", { name: client.name }) : t("outcome.waiting")}</Callout>;
    case "SIGNED":
      return (
        <Callout tone="success">
          {contract.signedOn ? t("outcome.signedOn", { date: day(contract.signedOn) }) : t("outcome.signed")}
        </Callout>
      );
    case "DECLINED":
      return <Callout tone="caution">{t("outcome.declined")}</Callout>;
    case "WITHDRAWN":
      return <Callout tone="caution">{t("outcome.withdrawn")}</Callout>;
  }
}

function SignatureItem({ signature: s, t, moment }: { signature: PortalSignature; t: T; moment: (d: Date) => string }) {
  return (
    <li
      className="flex flex-col gap-0.5 text-sm"
      data-testid={s.party === "TENANT" ? "portal-signature-agency" : "portal-signature-client"}
      data-status={s.status}
    >
      <span className="text-xs text-muted-foreground">{s.party === "TENANT" ? t("agency") : t("yourCompany")}</span>
      <span className="font-medium break-words">{s.name}</span>
      {s.status === "SIGNED" && s.decidedAt ? (
        <span className="text-muted-foreground">
          {t("signedAs", { name: s.typedName ?? s.name, when: moment(s.decidedAt) })}
        </span>
      ) : s.status === "DECLINED" && s.decidedAt ? (
        <>
          <span className="text-muted-foreground">{t("declinedAt", { when: moment(s.decidedAt) })}</span>
          {s.declineReason ? (
            <q className="whitespace-pre-wrap break-words text-muted-foreground" data-testid="portal-contract-decline-reason">
              {s.declineReason}
            </q>
          ) : null}
        </>
      ) : (
        <span className="text-muted-foreground">{s.status === "PENDING" ? t("notYetSigned") : t("notSigned")}</span>
      )}
    </li>
  );
}
