import { getFormatter, getTranslations } from "next-intl/server";

import { SectionCard } from "@/components/semantic";
import { SEALED_ASKS_PER_DAY, type PortalLogin, type SealedPortalState } from "@/modules/vault";

import { PortalLoginList } from "./login-list";
import { SealedAskForm, SealedConfirm, SealedWithdraw } from "./sealed-controls";

/**
 * THE SEALED LOGINS ON THE CLIENT'S LOGINS PAGE (Phase 3V slice 93; founder
 * decisions C52 (f)–(h), C61). Before asking, a COUNT only (C61 (a)): which
 * logins stays behind the opening. Then where the ask stands — waiting for
 * the agency, confirmable after the silent wait (through the door above),
 * opening in 48 hours, open (the list, behind the door), or ended (closed
 * again, denied with the answerer's reason, withdrawn, lapsed) — and the
 * form to ask again when one may.
 *
 * Every date is the agency's answer to "when", formatted by next-intl in
 * the request's zone, never the process's (the 418 trap).
 */
export async function SealedSection({
  state,
  doorOpen,
  opened,
}: {
  state: SealedPortalState;
  /** The client's door is open in this session. */
  doorOpen: boolean;
  /** What the open ask shows behind the open door; null otherwise. */
  opened: { readonly openUntil: Date; readonly logins: readonly PortalLogin[] } | null;
}) {
  const t = await getTranslations("portal.logins.sealed");
  const format = await getFormatter();
  const when = (d: Date) =>
    format.dateTime(d, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  const ask = state.ask;
  const s = ask?.state ?? null;
  const live = s !== null && (s.kind === "waiting" || s.kind === "confirmable" || s.kind === "opening" || s.kind === "open");

  const asked = ask ? (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-foreground">
        {ask.yours
          ? t("askedByYou", { date: when(ask.askedAt) })
          : t("askedBy", { name: ask.askedBy ?? t("someone"), date: when(ask.askedAt) })}
      </p>
      <blockquote className="border-l-2 border-border pl-3 text-sm whitespace-pre-line text-muted-foreground" data-testid="sealed-reason">
        {ask.reason}
      </blockquote>
    </div>
  ) : null;

  let body: React.ReactNode = null;
  if (ask && s) {
    switch (s.kind) {
      case "waiting":
        body = (
          <>
            {asked}
            <p className="text-sm text-foreground">{t("waiting", { date: when(s.confirmableAt) })}</p>
            <SealedWithdraw requestId={ask.id} />
          </>
        );
        break;
      case "confirmable":
        body = (
          <>
            {asked}
            <p className="text-sm text-foreground">{t("confirmable", { date: when(s.lapsesAt) })}</p>
            {doorOpen && state.confirmReady ? (
              <SealedConfirm requestId={ask.id} />
            ) : (
              <p className="text-sm text-muted-foreground">{doorOpen ? t("doorTooEarly") : t("confirmDoor")}</p>
            )}
            <SealedWithdraw requestId={ask.id} />
          </>
        );
        break;
      case "opening":
        body = (
          <>
            {asked}
            <p className="text-sm text-foreground">{t("opening", { date: when(s.opensAt) })}</p>
            <SealedWithdraw requestId={ask.id} />
          </>
        );
        break;
      case "open":
        body = (
          <>
            <p className="text-sm text-foreground">{t("open", { date: when(s.openUntil) })}</p>
            {doorOpen && opened ? null : <p className="text-sm text-muted-foreground">{t("openDoor")}</p>}
          </>
        );
        break;
      case "closed":
        body = <p className="text-sm text-foreground">{t("closed", { date: when(s.closedAt) })}</p>;
        break;
      case "denied":
        body = (
          <>
            <p className="text-sm text-foreground">{t("denied", { date: when(s.deniedAt) })}</p>
            {ask.denyReason ? (
              <div className="flex flex-col gap-1">
                <p className="text-xs text-muted-foreground">{t("denyReason")}</p>
                <blockquote className="border-l-2 border-border pl-3 text-sm whitespace-pre-line text-foreground" data-testid="sealed-deny-reason">
                  {ask.denyReason}
                </blockquote>
              </div>
            ) : null}
          </>
        );
        break;
      case "withdrawn":
        body = <p className="text-sm text-foreground">{t("withdrawnOn", { date: when(s.withdrawnAt) })}</p>;
        break;
      case "lapsed":
        body = <p className="text-sm text-foreground">{t("lapsed")}</p>;
        break;
    }
  }

  return (
    <SectionCard
      title={t("title")}
      description={
        state.count === 0
          ? t("noneNow")
          : s?.kind === "open"
            ? // What opened is what was sealed when the ask was decided — a
              // login sealed since stays shut, so "which ones" is not "all".
              t("countWhileOpen", { count: state.count })
            : t("count", { count: state.count })
      }
      contentClassName={opened && doorOpen ? "p-0" : undefined}
    >
      <div
        className={opened && doorOpen ? "flex flex-col" : "flex flex-col gap-4"}
        data-testid="sealed-section"
        data-state={s?.kind ?? "none"}
      >
        {opened && doorOpen ? (
          <>
            <p className="hairline-b px-4 py-2 text-xs text-muted-foreground">
              {t("openList", { date: when(opened.openUntil) })}
            </p>
            <PortalLoginList logins={opened.logins} kind="sealed" />
          </>
        ) : (
          <>
            {body}
            {!live && state.askAgainAt ? (
              <p className="text-sm text-muted-foreground">{t("askAgainOn", { date: when(state.askAgainAt) })}</p>
            ) : null}
            {!live && state.limitedToday && state.askAgainAt === null && state.count > 0 ? (
              <p className="text-sm text-muted-foreground">{t("tooOften", { max: SEALED_ASKS_PER_DAY })}</p>
            ) : null}
            {state.canAsk ? (
              <>
                <p className="text-sm text-muted-foreground">{t("intro", { days: state.waitDays })}</p>
                <SealedAskForm />
              </>
            ) : null}
          </>
        )}
      </div>
    </SectionCard>
  );
}
