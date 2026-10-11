"use client";

import { DownloadIcon, FilePenLineIcon, Undo2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { ContractBodyEditor } from "@/components/contracts/contract-body-editor";
import { Callout, RowActions, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { isActionRedirect } from "@/lib/action-redirect";
import type { ContractSignatureView, ContractStatus } from "@/modules/contracts";

import { changeContractAction, contractPdfUrlAction, newVersionAction, withdrawContractAction } from "../actions";

/** Where focus lands when the control that held it is gone (a send, a withdrawal): never <body>. */
export const SENT_HEADING_ID = "contract-signatures";

/**
 * A send just succeeded on this page: the next sent view to mount takes focus
 * (the send dialog's trigger unmounts with the draft editor AFTER the dialog
 * has closed, so the dialog cannot hand focus over itself — the code review's
 * low). A request of this browser tab, consumed once — and only for a few
 * seconds, so a send whose page was left before the sent view mounted does not
 * hand focus to some later contract's page (the fix re-check's low).
 */
const FOCUS_REQUEST_MS = 5_000;
let focusRequestedAt = 0;
export const focusSignaturesNext = (): void => {
  focusRequestedAt = Date.now();
};

/**
 * The request, consumed: true when one is fresh. A PLAIN function, never inline
 * in the component (slice 112b2, AGENTS.md's standing trap): the React
 * Compiler treats a module-level binding as a constant and would turn
 * `const asked = focusRequestedAt; focusRequestedAt = 0; … asked` into a read
 * of the variable AFTER its reset — this hand-off would then never happen, with
 * nothing to say so. It worked only because the compiler skips this component.
 */
function takeSignaturesFocus(): boolean {
  const asked = focusRequestedAt;
  focusRequestedAt = 0;
  return asked !== 0 && Date.now() - asked <= FOCUS_REQUEST_MS;
}

/**
 * A SENT CONTRACT (Phase 4 slice 112b; C84) — what it is now and who signed:
 * the agency's signature (the sender, at sending) and the client's (waiting,
 * signed or declined, with the reason when one was given); the PDF as sent and,
 * once signed, the signed copy; the text, read-only — a sent contract never
 * changes. Its verbs, each shown only where the service accepts it: Withdraw
 * and Change it while it waits (`contract:send`), New version once it was
 * declined or withdrawn (`contract:create`).
 */
export function SentContract({
  contractId,
  status,
  body,
  signatures,
  hasSignedPdf,
  contentSha256,
  canSend,
  canCreate,
  replaced,
}: {
  contractId: string;
  status: ContractStatus;
  body: unknown;
  signatures: readonly ContractSignatureView[];
  hasSignedPdf: boolean;
  contentSha256: string | null;
  canSend: boolean;
  canCreate: boolean;
  /** A newer version already exists. */
  replaced: boolean;
}) {
  const t = useTranslations("contracts.sent");
  const format = useFormatter();
  const router = useRouter();
  const [busy, setBusy] = useState<"sent" | "signed" | null>(null);
  const [, start] = useTransition();
  useEffect(() => {
    if (takeSignaturesFocus()) document.getElementById(SENT_HEADING_ID)?.focus();
  }, []);

  /** An action's call, its failure a toast — never the error boundary, never a revert-looking silence. */
  const act = (fn: () => Promise<void>) =>
    start(async () => {
      try {
        await fn();
      } catch (e) {
        if (isActionRedirect(e)) return;
        toast.error(t("unreachable"));
      }
    });

  const download = async (kind: "sent" | "signed") => {
    if (busy) return;
    setBusy(kind);
    try {
      const r = await contractPdfUrlAction(contractId, kind);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      window.location.assign(r.value);
    } catch (e) {
      if (isActionRedirect(e)) return;
      toast.error(t("unreachable"));
    } finally {
      setBusy(null);
    }
  };

  const open = status === "SENT";
  const items = [
    ...(open && canSend && canCreate
      ? [
          {
            key: "change",
            label: t("change"),
            icon: FilePenLineIcon,
            tone: "danger" as const,
            confirm: t("changeConfirm"),
            onSelect: () =>
              act(async () => {
                const r = await changeContractAction(contractId);
                if (!r.ok) {
                  toast.error(r.message);
                  return;
                }
                toast.success(t("changed"));
                router.push(`/contracts/${r.value}`);
              }),
          },
        ]
      : []),
    ...(open && canSend
      ? [
          {
            key: "withdraw",
            label: t("withdraw"),
            icon: Undo2Icon,
            tone: "danger" as const,
            confirm: t("withdrawConfirm"),
            onSelect: () =>
              act(async () => {
                const r = await withdrawContractAction(contractId);
                if (!r.ok) {
                  toast.error(r.message);
                  return;
                }
                toast.success(r.message);
                document.getElementById(SENT_HEADING_ID)?.focus();
              }),
          },
        ]
      : []),
    ...((status === "DECLINED" || status === "WITHDRAWN") && canCreate && !replaced
      ? [
          {
            key: "new-version",
            label: t("newVersion"),
            icon: FilePenLineIcon,
            onSelect: () =>
              act(async () => {
                const r = await newVersionAction(contractId);
                if (!r.ok) {
                  toast.error(r.message);
                  return;
                }
                router.push(`/contracts/${r.value}`);
              }),
          },
        ]
      : []),
  ];

  const sig = (party: "TENANT" | "CLIENT") => signatures.find((s) => s.party === party) ?? null;
  const agency = sig("TENANT");
  const client = sig("CLIENT");
  const when = (d: Date | null) => (d ? format.dateTime(d, { dateStyle: "medium", timeStyle: "short" }) : "");

  return (
    <div className="flex flex-col gap-4" data-testid="sent-contract">
      {status === "WITHDRAWN" ? <Callout tone="caution" title={t("withdrawnTitle")}>{t("withdrawnBody")}</Callout> : null}
      {status === "DECLINED" ? (
        <Callout tone="caution" title={t("declinedTitle")}>
          {client?.declineReason ? t("declinedReason", { reason: client.declineReason }) : t("declinedNoReason")}
        </Callout>
      ) : null}
      <SectionCard
        title={
          <span id={SENT_HEADING_ID} tabIndex={-1} className="outline-none">
            {t("signatures")}
          </span>
        }
        actions={items.length > 0 ? <RowActions label={t("menu")} items={items} /> : null}
      >
        <dl className="grid gap-3 sm:grid-cols-2" data-testid="contract-signatures">
          <div className="flex min-w-0 flex-col gap-0.5" data-testid="signature-agency">
            <dt className="text-xs text-muted-foreground">{t("agency")}</dt>
            <dd className="text-sm font-medium">{agency?.typedName ?? agency?.signerName ?? "—"}</dd>
            <dd className="text-xs text-muted-foreground">{t("signedAt", { when: when(agency?.decidedAt ?? null) })}</dd>
          </div>
          <div className="flex min-w-0 flex-col gap-0.5" data-testid="signature-client" data-status={client?.status ?? ""}>
            <dt className="text-xs text-muted-foreground">{t("client", { name: client?.signerName ?? "" })}</dt>
            <dd className="text-sm font-medium">
              {/* A withdrawn contract's client row stays PENDING for ever: it
                  waits only while the contract does (slice 112b2's rule). */}
              {client?.status === "SIGNED"
                ? client.typedName
                : client?.status === "DECLINED"
                  ? t("declined")
                  : status === "SENT"
                    ? t("waiting")
                    : t("notSigned")}
            </dd>
            {client?.decidedAt ? (
              <dd className="text-xs text-muted-foreground">
                {client.status === "SIGNED" ? t("signedAt", { when: when(client.decidedAt) }) : t("declinedAt", { when: when(client.decidedAt) })}
              </dd>
            ) : null}
          </div>
        </dl>
        {contentSha256 ? (
          <p className="mt-3 text-xs break-all text-muted-foreground" data-testid="contract-fingerprint">
            {t("fingerprint", { hash: contentSha256 })}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void download("sent")} aria-disabled={busy !== null} data-testid="contract-download-sent">
            <DownloadIcon aria-hidden="true" />
            {t("downloadSent")}
          </Button>
          {status === "SIGNED" ? (
            <Button type="button" size="sm" onClick={() => void download("signed")} aria-disabled={busy !== null} data-testid="contract-download-signed">
              <DownloadIcon aria-hidden="true" />
              {hasSignedPdf ? t("downloadSigned") : t("downloadSignedMake")}
            </Button>
          ) : null}
        </div>
      </SectionCard>
      <SectionCard title={t("text")}>
        <ContractBodyEditor
          id="contract-body"
          initialDoc={body}
          placeholder={t("text")}
          ariaLabel={t("text")}
          fillIns={false}
          readOnly
          testId="contract-body"
          onChange={() => undefined}
        />
      </SectionCard>
    </div>
  );
}
