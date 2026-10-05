"use client";

import { ExternalLinkIcon, KeyRoundIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { fieldLabelKey, isMultilineSecret } from "@/app/(tenant)/(authed)/vault/vault-shape";
import { Button } from "@/components/ui/button";
import { SecretField, type SecretFieldCall } from "@/components/vault/secret-field";

import { lookAtLoginAction, lookAtSealedLoginAction } from "./actions";

/** One shown login, as the page hands it down — names, never a value. */
export type PortalLoginRow = {
  readonly id: string;
  readonly name: string;
  readonly username: string | null;
  readonly url: string | null;
  readonly fields: readonly string[];
};

/**
 * THE LOGINS BEHIND THE OPEN DOOR (Phase 3V slice 91): each one's name,
 * username and web address as text, and each secret field masked with the
 * staff vault's own eye and copy (`SecretField`) — fetched through this
 * page's action, so every look is the CLIENT's: their open door, their
 * hourly budget, audited to them. No one-time codes (C59 (d)).
 */
export function PortalLoginList({
  logins,
  kind,
}: {
  logins: readonly PortalLoginRow[];
  /**
   * Which logins these are — the ones the agency SHOWS (slice 91) or the
   * SEALED ones an ask has opened (slice 93) — and so which broker each
   * look goes through. Required: a sealed row looked at as a shown one
   * would be refused, and the reverse too.
   */
  kind: "shown" | "sealed";
}) {
  return (
    <ul className="divide-y divide-border" data-testid={kind === "shown" ? "portal-logins" : "portal-sealed-logins"}>
      {logins.map((login) => (
        <PortalLogin key={login.id} login={login} kind={kind} />
      ))}
    </ul>
  );
}

function PortalLogin({ login, kind }: { login: PortalLoginRow; kind: "shown" | "sealed" }) {
  const t = useTranslations("portal.logins.row");
  const tVault = useTranslations("vault");
  const call: SecretFieldCall = (look, field) =>
    kind === "shown" ? lookAtLoginAction(login.id, field, look) : lookAtSealedLoginAction(login.id, field, look);
  return (
    <li className="flex flex-col gap-2 px-4 py-3" data-testid="portal-login" data-name={login.name}>
      <div className="flex min-w-0 items-center gap-2">
        <KeyRoundIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium text-foreground">{login.name}</span>
      </div>
      <dl className="grid min-w-0 gap-x-4 gap-y-1 sm:grid-cols-2">
        <div className="flex min-w-0 items-center gap-2">
          <dt className="w-28 shrink-0 text-xs text-muted-foreground">{t("username")}</dt>
          <dd className="min-w-0 flex-1 truncate pl-2.5 font-mono text-sm text-foreground">
            {login.username ?? t("notSet")}
          </dd>
        </div>
        {login.url ? (
          <div className="flex min-w-0 items-center gap-2">
            <dt className="w-28 shrink-0 text-xs text-muted-foreground">{t("url")}</dt>
            <dd className="flex min-w-0 flex-1 items-center gap-1">
              <span className="min-w-0 flex-1 truncate pl-2.5 text-sm text-foreground">{login.url}</span>
              <Button asChild variant="ghost" size="icon-sm">
                <a href={login.url} target="_blank" rel="noreferrer noopener" aria-label={t("openUrl", { name: login.name })}>
                  <ExternalLinkIcon />
                </a>
              </Button>
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="flex min-w-0 flex-col gap-1">
        {login.fields.map((key) => (
          <SecretField
            key={key}
            credentialId={login.id}
            field={key}
            label={tVault(fieldLabelKey(key))}
            canReveal
            multiline={isMultilineSecret(key)}
            call={call}
            failureNamespace="portal.logins.errors"
          />
        ))}
      </div>
    </li>
  );
}
