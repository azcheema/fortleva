import { getFormatter, getTranslations } from "next-intl/server";

import { SectionCard, StatusBadge } from "@/components/semantic";
import { ASK_MAIL_EVERY_HOURS, CREDENTIAL_TYPES, type AskTargets, type LoginAskView } from "@/modules/vault";

import { AskForLoginDialog } from "./ask-dialog";
import { CancelAskButton } from "./cancel-ask-button";
import type { VaultSurface } from "./surface";

/** Between the parts of a row's second line — punctuation, not words. */
const SEPARATOR = " · ";

/**
 * LOGINS ASKED OF THE CLIENT (Phase 3V slice 98; founder decision C66) — on
 * the client's and a project's Vault tab, behind the vault's door like the
 * logins beside it: every open ask first, then those answered or cancelled
 * in the last 30 days (`listLoginAsks`), each saying who was asked, by whom,
 * when and how it ended — the login it became (a link to its row on this
 * page), or the client's note when they do not have it. "Ask for a login…"
 * for a member who may ask here (`credential:create` — C66 (d)), while a
 * client could answer and somebody at the client can be asked.
 *
 * Drawn only when there is something to show or to do: a workspace that
 * does not take logins from clients, and has no ask left in its history,
 * sees nothing new on its Vault tab.
 */
export async function LoginAsksSection({
  surface,
  clientId,
  clientName,
  asks,
  targets,
}: {
  surface: VaultSurface;
  clientId: string;
  clientName: string;
  asks: readonly LoginAskView[];
  targets: AskTargets;
}) {
  const asking = targets.canAsk && targets.open && targets.places.length > 0;
  if (asks.length === 0 && !asking) return null;
  const t = await getTranslations("vault.asks");
  const tVault = await getTranslations("vault");
  const format = await getFormatter();
  const when = (d: Date) => format.dateTime(d, { year: "numeric", month: "short", day: "numeric" });

  return (
    <SectionCard
      title={t("title")}
      description={t("description")}
      actions={
        asking && targets.contacts.length > 0 ? (
          <AskForLoginDialog
            surface={surface}
            clientId={clientId}
            clientName={clientName}
            places={targets.places}
            contacts={targets.contacts}
            types={CREDENTIAL_TYPES}
            mailEveryHours={ASK_MAIL_EVERY_HOURS}
          />
        ) : null
      }
      contentClassName="p-0"
    >
      {asking && targets.contacts.length === 0 ? (
        <p className="border-b border-border px-4 py-2 text-sm text-muted-foreground" data-testid="ask-nobody">
          {t("nobody")}
        </p>
      ) : null}
      {asks.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul data-testid="login-asks" className="flex flex-col divide-y divide-border">
          {asks.map((a) => {
            const status =
              a.state.kind === "open"
                ? "OPEN"
                : a.state.kind === "sent"
                  ? "SENT"
                  : a.state.kind === "declined"
                    ? "DECLINED"
                    : "CANCELLED";
            const contact = a.contact.name ?? t("someone");
            const meta = [
              ...(a.projectKey ? [a.projectKey] : []),
              tVault(`types.${a.type}`),
              t("askedOf", { contact, member: a.askedBy ?? t("someone"), date: when(a.askedAt) }),
            ].join(SEPARATOR);
            return (
              <li
                key={a.id}
                data-testid="login-ask"
                data-state={a.state.kind}
                className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-2"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-sm font-medium text-foreground">{a.name}</span>
                    <StatusBadge domain="loginAsk" value={status} />
                  </div>
                  <span className="text-xs text-muted-foreground">{meta}</span>
                  {a.state.kind === "sent" ? (
                    <span className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
                      <span>{t("sentOn", { date: when(a.state.at) })}</span>
                      {/* Only while the login is live, so listed on this page. */}
                      {a.state.credentialId ? (
                        <a
                          href={`#credential-${a.state.credentialId}`}
                          className="rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          {t("showLogin")}
                        </a>
                      ) : null}
                    </span>
                  ) : null}
                  {a.state.kind === "declined" ? (
                    <span className="text-xs text-muted-foreground">
                      {a.state.note
                        ? t("declinedNote", { contact, date: when(a.state.at), note: a.state.note })
                        : t("declinedOn", { contact, date: when(a.state.at) })}
                    </span>
                  ) : null}
                  {a.state.kind === "cancelled" ? (
                    <span className="text-xs text-muted-foreground">
                      {t("cancelledBy", { member: a.state.by ?? t("someone"), date: when(a.state.at) })}
                    </span>
                  ) : null}
                  {a.stuck ? (
                    <span className="text-xs text-muted-foreground" data-testid="login-ask-stuck">
                      {t("stuck", { contact })}
                    </span>
                  ) : null}
                </div>
                {a.state.kind === "open" && targets.canCancel ? (
                  <CancelAskButton surface={surface} askId={a.id} name={a.name} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
