"use client";

import { CheckIcon, LinkIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Callout, Field } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult, FormResult } from "@/lib/server-actions";
import { TONE_LINE } from "@/lib/tones";
import { cn } from "@/lib/utils";
import type { AccountRole, ConnectOutcome, FortnoxCheck } from "@/modules/invoicing";

/** What the page hands the card — dates as ISO strings. */
export type FortnoxCardProps = {
  readonly available: boolean;
  readonly canConnect: boolean;
  readonly canCheck: boolean;
  readonly hasOrgNr: boolean;
  readonly connection: {
    readonly status: "ACTIVE" | "BROKEN";
    readonly companyName: string;
    readonly companyOrgNr: string;
    readonly connectedAt: string;
    readonly connectedBy: string | null;
    readonly brokenKind: string | null;
    readonly foreign: boolean;
  } | null;
  readonly orgDiffers: boolean;
  readonly pending: { readonly count: number; readonly first: string | null; readonly last: string | null } | null;
  /** Entries a disconnect left never sent (slice 114c) — for a viewer the Bookkeeping page opens for. */
  readonly unsent: number | null;
  readonly outcome: { readonly outcome: ConnectOutcome; readonly seenCompanyName: string | null; readonly seenOrgNr: string | null } | null;
};

/** Every kind of stop the card can name (slice 114b writes them); anything else reads as REFUSED. */
const BROKEN_KINDS = [
  "CONSENT_GONE",
  "NO_LICENCE",
  "COMPANY_CHANGED",
  "NO_FINANCIAL_YEAR",
  "SERIES",
  "ACCOUNT",
  "PERIOD_LOCKED",
  "PDF_MISSING",
  "NOT_ANSWERING",
  "REFUSED",
] as const;
type BrokenKind = (typeof BROKEN_KINDS)[number];
const isBrokenKind = (v: string | null | undefined): v is BrokenKind => (BROKEN_KINDS as readonly string[]).includes(v ?? "");
/** Kinds of stop only a reconnect mends (the design review's S3). */
const NEEDS_RECONNECT: ReadonlySet<BrokenKind> = new Set<BrokenKind>(["CONSENT_GONE", "NO_LICENCE", "COMPANY_CHANGED"]);

/** The card's in-text link (as its "set up an authenticator" link). */
const UNSENT_LINK = "rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Next rejects a server action's promise with its redirect, then navigates by itself. */
const isRedirect = (e: unknown): boolean => {
  const digest = typeof e === "object" && e !== null ? (e as { digest?: unknown }).digest : undefined;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
};

/**
 * THE FORTNOX CARD (Phase 4 slice 114; founder decision C89) on Settings →
 * Invoicing: connect the workspace's Fortnox company (owners, with the code
 * typed here — C89 (d)), the company it is connected to, "Is Fortnox ready?",
 * and disconnect. Nothing is sent by this slice; the nightly send is 114b.
 *
 * The code field is the protected cards' (`protected-card.tsx`): a submit
 * handler, never a `<form action>` (React 19 resets a form around its
 * action); a refusal before the code was checked keeps it, otherwise it is
 * cleared; buttons `aria-disabled`, never `disabled`. Connect leaves the page
 * for Fortnox's consent screen (`window.location.assign`), which sends the
 * administrator back to the callback and then here, with the attempt's
 * outcome read from the viewer's own row (never the URL); a callback that
 * found no attempt says only that (`expired`). With the transport off the
 * card says the connection is not available — and still shows a connection
 * made earlier, with Disconnect (it needs no Fortnox: the code review's 8).
 */
export function FortnoxCard({
  card,
  expired,
  series,
  hasFactor,
  enrolHref,
  begin,
  disconnect,
  check,
}: {
  card: FortnoxCardProps;
  /** The callback found no attempt — it ran out of time, or was used already. */
  expired: boolean;
  /** The bookkeeping setting's voucher series — the one Fortnox must have, marked manual. */
  series: string;
  hasFactor: boolean;
  enrolHref: string;
  begin: (code: string) => Promise<ActionResult<{ url: string }> & { codeChecked?: boolean }>;
  disconnect: (code: string) => Promise<FormResult & { codeChecked?: boolean }>;
  check: () => Promise<ActionResult<FortnoxCheck>>;
}) {
  const t = useTranslations("settings.invoicing.fortnox");
  const format = useFormatter();
  const router = useRouter();
  const [mode, setMode] = useState<"rest" | "connect" | "disconnect">("rest");
  const [code, setCode] = useState("");
  const [pending, start] = useTransition();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<FortnoxCheck | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  /**
   * The verb whose button opened the form. The form REPLACES the button, so a
   * ref to it would point at a detached element: once the card is back at rest,
   * focus goes to that verb's button as it is drawn now (the fix re-check's 4)
   * — after Cancel, or after a disconnect, to whatever verb stands there then.
   */
  const lastVerb = useRef<"connect" | "reconnect" | "disconnect" | null>(null);
  /** A second press while a check runs is ignored (state reads stale between renders). */
  const checkingRef = useRef(false);
  const autoChecked = useRef(false);
  const day = (d: string) => format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });

  const c = card.connection;
  const justConnected = c !== null && (card.outcome?.outcome === "CONNECTED" || card.outcome?.outcome === "RECONNECTED");
  // A connected outcome is shown only while there is a connection to show it on.
  const connectedOutcome = card.outcome?.outcome === "CONNECTED" || card.outcome?.outcome === "RECONNECTED" || card.outcome?.outcome === "ALREADY";
  const outcome = connectedOutcome && c === null ? null : card.outcome;

  const open = (m: "connect" | "disconnect", verb: "connect" | "reconnect" | "disconnect") => {
    lastVerb.current = verb;
    setCode("");
    setMode(m);
    // After the form mounts: its code field (never `autoFocus`, AGENTS.md).
    requestAnimationFrame(() => codeRef.current?.focus());
  };
  const close = () => setMode("rest");

  // Back at rest: focus the verb that opened the form, or the one in its place.
  useEffect(() => {
    if (mode !== "rest" || lastVerb.current === null) return;
    const verb = lastVerb.current;
    lastVerb.current = null;
    requestAnimationFrame(() => {
      const root = cardRef.current;
      const button =
        root?.querySelector<HTMLButtonElement>(`[data-testid="fortnox-${verb}"]`) ??
        root?.querySelector<HTMLButtonElement>('button[data-testid^="fortnox-"]');
      button?.focus();
    });
  }, [mode]);

  const runCheck = async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const r = await check();
      if (r.ok) setResult(r.value);
      else toast.error(r.message);
    } catch (err) {
      if (!isRedirect(err)) toast.error(t("unreachable"));
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  };

  // Just connected: ask Fortnox once whether it is ready (the design's §4.3).
  useEffect(() => {
    if (!justConnected || !card.canCheck || !card.available || autoChecked.current) return;
    autoChecked.current = true;
    void runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival from Fortnox
  }, [justConnected, card.canCheck, card.available]);

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    start(async () => {
      try {
        if (mode === "connect") {
          const r = await begin(code);
          if (!r.ok) {
            if (r.codeChecked !== false) setCode("");
            toast.error(r.message);
            return;
          }
          // To Fortnox's consent screen; it sends the administrator back here.
          window.location.assign(r.value.url);
          return;
        }
        const r = await disconnect(code);
        if (!r.ok) {
          if (r.codeChecked !== false) setCode("");
          toast.error(r.message);
          return;
        }
        toast.success(r.message);
        setResult(null);
        setMode("rest");
        // Off the attempt's URL, so its "Connected" note goes with the connection (the code review's 6).
        router.replace("/settings/invoicing#fortnox");
      } catch (err) {
        if (isRedirect(err)) return;
        toast.error(t("unreachable"));
      }
    });
  };

  const kind: BrokenKind = isBrokenKind(c?.brokenKind) ? c.brokenKind : "REFUSED";
  const codeForm = (label: string, intro: string, submitLabel: string, tone: "default" | "destructive") => (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label={label}>
      <p className="text-sm text-muted-foreground">{intro}</p>
      <Field label={t("codeLabel")} htmlFor="fortnox-code" hint={t("codeHint")}>
        <Input
          id="fortnox-code"
          ref={codeRef}
          value={code}
          onChange={(ev) => setCode(ev.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={32}
          className="num-id w-40 font-mono"
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={tone === "destructive" ? "destructive" : "default"} aria-disabled={pending}>
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" onClick={() => !pending && close()} aria-disabled={pending}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );

  /** An owner's verb — or, without an authenticator, the way to set one up. */
  const ownerVerb = (verb: "connect" | "reconnect" | "disconnect") =>
    card.canConnect ? (
      hasFactor ? (
        <Button
          type="button"
          variant={verb === "disconnect" ? "outline" : "default"}
          onClick={() => open(verb === "disconnect" ? "disconnect" : "connect", verb)}
          data-testid={`fortnox-${verb}`}
        >
          {verb === "disconnect" ? <XIcon aria-hidden="true" /> : <LinkIcon aria-hidden="true" />}
          {t(`${verb}.open`)}
        </Button>
      ) : (
        <p className="text-sm" data-testid="fortnox-needs-factor">
          {t("needsFactor")}{" "}
          <Link
            href={enrolHref}
            className="rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t("setUpFactor")}
          </Link>
        </p>
      )
    ) : null;

  return (
    <div ref={cardRef} className="flex flex-col gap-4" data-testid="fortnox-card">
      {!card.available ? (
        <p className="text-sm text-muted-foreground" data-testid="fortnox-unavailable">
          {t("unavailable")}
        </p>
      ) : null}
      {outcome ? <OutcomeNote outcome={outcome} /> : null}
      {expired ? (
        <div data-testid="fortnox-expired">
          <Callout tone="caution" role="status" title={t("expired.title")}>
            {t("expired.body")}
          </Callout>
        </div>
      ) : null}
      {card.unsent !== null && card.unsent > 0 ? (
        // Slice 114c (C90 (c)): what a disconnect left — never sent by a later connection.
        <div data-testid="fortnox-unsent">
          <Callout tone="caution" title={t("unsent.title", { count: card.unsent })}>
            {t("unsent.body")}{" "}
            <Link href="/invoices/bookkeeping#needs-you" className={UNSENT_LINK}>
              {t("unsent.action")}
            </Link>
          </Callout>
        </div>
      ) : null}

      {c === null ? (
        card.available ? (
          <>
            <p className="text-sm">{t("intro")}</p>
            <div className="flex flex-col gap-1 text-sm">
              <p className="font-medium">{t("needs.title")}</p>
              <ul className="list-disc ps-5 text-muted-foreground">
                <li>{t("needs.addOn")}</li>
                <li>{t("needs.admin")}</li>
                <li>{t("needs.series", { series })}</li>
                <li>{t("needs.year")}</li>
              </ul>
            </div>
            {card.pending && card.pending.count > 0 ? (
              <div data-testid="fortnox-pending">
                <Callout tone="caution" title={t("pending.title", { count: card.pending.count })}>
                  {card.pending.first && card.pending.last
                    ? t("pending.body", { first: day(card.pending.first), last: day(card.pending.last) })
                    : t("pending.bodyUndated")}
                </Callout>
              </div>
            ) : null}
            {mode === "connect" ? (
              codeForm(t("connect.formLabel"), t("connect.intro"), t("connect.submit"), "default")
            ) : !card.canConnect ? (
              <p className="text-sm text-muted-foreground">{t("ownersOnly")}</p>
            ) : !hasFactor ? (
              // No authenticator: the way to set one up first (`ownerVerb` draws it).
              ownerVerb("connect")
            ) : !card.hasOrgNr ? (
              <p className="text-sm" data-testid="fortnox-needs-org-nr">
                {t("needsOrgNr")}
              </p>
            ) : (
              <div>{ownerVerb("connect")}</div>
            )}
          </>
        ) : null
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{t("company")}</dt>
              <dd className="min-w-0 text-sm wrap-break-word" data-testid="fortnox-company">
                {c.companyName}
              </dd>
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{t("orgNr")}</dt>
              <dd className="num-id min-w-0 font-mono text-sm">{c.companyOrgNr}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            {t("connectedBy", {
              name: c.connectedBy ?? t("someoneGone"),
              when: format.dateTime(new Date(c.connectedAt), { dateStyle: "medium", timeStyle: "short" }),
            })}
          </p>
          {card.available ? (
            c.status === "ACTIVE" ? (
              <div data-testid="fortnox-active">
                <Callout tone="success">{t("active")}</Callout>
              </div>
            ) : (
              <div data-testid="fortnox-broken">
                <Callout tone="caution" title={t("broken.title")}>
                  {t(`broken.kinds.${kind}`)} {NEEDS_RECONNECT.has(kind) ? t("broken.reconnect") : t("broken.retrying")}
                </Callout>
              </div>
            )
          ) : null}
          {c.foreign ? <Callout tone="caution">{t("foreign")}</Callout> : null}
          {card.orgDiffers ? <Callout tone="caution">{t("orgDiffers")}</Callout> : null}

          {result ? <CheckResult result={result} /> : null}

          {mode === "rest" ? (
            <div className="flex flex-wrap items-center gap-2">
              {card.available && card.canCheck && !c.foreign ? (
                <Button type="button" variant="outline" onClick={() => void runCheck()} aria-disabled={checking} data-testid="fortnox-check">
                  <ShieldCheckIcon aria-hidden="true" />
                  {checking ? t("checking") : result ? t("checkAgain") : t("check")}
                </Button>
              ) : null}
              {card.available && c.status === "BROKEN" && NEEDS_RECONNECT.has(kind) && !c.foreign ? ownerVerb("reconnect") : null}
              {ownerVerb("disconnect")}
            </div>
          ) : mode === "connect" ? (
            codeForm(t("reconnect.formLabel"), t("reconnect.intro"), t("connect.submit"), "default")
          ) : (
            codeForm(t("disconnect.formLabel"), t("disconnect.intro"), t("disconnect.submit"), "destructive")
          )}
          <p className="text-xs text-muted-foreground">{t("removeInFortnox")}</p>
        </>
      )}
    </div>
  );
}

/** What came of the viewer's own Connect, read from their attempt row. */
function OutcomeNote({ outcome }: { outcome: NonNullable<FortnoxCardProps["outcome"]> }) {
  const t = useTranslations("settings.invoicing.fortnox.outcome");
  const ok = outcome.outcome === "CONNECTED" || outcome.outcome === "RECONNECTED" || outcome.outcome === "ALREADY";
  return (
    <div data-testid="fortnox-outcome" data-outcome={outcome.outcome}>
      <Callout tone={ok ? "success" : "danger"} role={ok ? "status" : "alert"} title={t(`${outcome.outcome}.title`)}>
        {outcome.outcome === "ORG_MISMATCH"
          ? t("ORG_MISMATCH.body", { name: outcome.seenCompanyName ?? "-", orgNr: outcome.seenOrgNr ?? "-" })
          : t(`${outcome.outcome}.body`)}
      </Callout>
    </div>
  );
}

/** "Is Fortnox ready?" — one line per question, the ten accounts in one line when all is well. */
function CheckResult({ result }: { result: FortnoxCheck }) {
  const t = useTranslations("settings.invoicing.fortnox.checkResult");
  const tAccounts = useTranslations("settings.invoicing.bookkeeping.accounts");
  const format = useFormatter();
  const accounts = result.items.filter((i) => i.key === "account");
  const accountsOk = accounts.length > 0 && accounts.every((i) => i.ok);
  const lines: { readonly ok: boolean; readonly text: string }[] = [];
  for (const item of result.items) {
    switch (item.key) {
      case "consent":
        lines.push({ ok: item.ok, text: item.ok ? t("consent.ok") : t(`consent.${item.problem ?? "unreachable"}`) });
        break;
      case "year":
        lines.push({
          ok: item.ok,
          text: item.ok
            ? t("year.ok")
            : t("year.missing", { day: format.dateTime(new Date(`${item.day}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }) }),
        });
        break;
      case "method":
        lines.push({
          ok: item.ok,
          text: item.ok
            ? t("method.ok")
            : t("method.differs", { fortnox: t(`methods.${item.fortnox ?? "ACCRUAL"}`), ours: t(`methods.${item.ours === "CASH" ? "CASH" : "ACCRUAL"}`) }),
        });
        break;
      case "series":
        lines.push({ ok: item.ok, text: item.ok ? t("series.ok", { series: item.series }) : t(`series.${item.problem ?? "missing"}`, { series: item.series }) });
        break;
      case "account":
        if (!item.ok) lines.push({ ok: false, text: t(`account.${item.problem ?? "missing"}`, { account: item.account, role: tAccounts(item.role as AccountRole) }) });
        break;
      case "refused":
        lines.push({ ok: false, text: t("refused", { detail: item.detail ?? "-", code: item.code ?? "-" }) });
        break;
    }
  }
  if (accountsOk) lines.push({ ok: true, text: t("accountsOk", { count: accounts.length }) });
  return (
    <div className="flex flex-col gap-1.5" data-testid="fortnox-check-result" data-ok={result.ok ? "true" : "false"}>
      <p className="text-sm font-medium" role="status">
        {result.ok ? t("readyTitle") : t("notReadyTitle")}
      </p>
      <ul className="flex flex-col gap-1">
        {lines.map((l, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            {l.ok ? (
              <CheckIcon aria-label={t("okLabel")} className={cn("mt-0.5 size-4 shrink-0", TONE_LINE.success)} />
            ) : (
              <XIcon aria-label={t("problemLabel")} className={cn("mt-0.5 size-4 shrink-0", TONE_LINE.danger)} />
            )}
            <span>{l.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
