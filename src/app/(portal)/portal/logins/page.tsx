import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { Page, PageHeader, SectionCard } from "@/components/semantic";
import { VaultLockTimer } from "@/components/vault/vault-lock-timer";
import { listPortalLogins, readPortalLoginsDoor } from "@/modules/vault";
import { portalReadOrNull } from "@/portal";
import { requirePortalContext } from "@/portal/context";

import { loginsShown } from "../logins-shown";
import { PortalFrame } from "../portal-frame";
import { PortalTasksEmpty } from "../task-list";
import { LoginsDoor } from "./logins-door";
import { PortalLoginList } from "./login-list";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal.logins");
  return { title: t("title") };
}

/** How long the door has left, from this request's clock — handed to the lock timer (the staff vault's way). */
const msUntil = (at: Date): number => at.getTime() - Date.now();

/**
 * `/portal/logins` — THE LOGINS AN AGENCY SHOWS ITS CLIENT (Phase 3V slice
 * 91; founder decisions C52 (d) and (k), C59). Main contacts only, while the
 * agency has client logins switched on; behind the client's door — their
 * portal password AND a code mailed each time — which stays open for the
 * staff window in this session, then the page locks itself.
 *
 * NO VIEW-AS TWIN, on purpose (C52: never under View-as): every read here
 * is bound to the portal SESSION (`requirePortalContext().sessionId`), which
 * a member looking through a contact does not have, and
 * `vault-boundary.test.ts` holds the door's and the list's callers to this
 * route. The nav entry still renders inertly inside View-as's frame — it
 * draws from a count, never from this page.
 *
 * EVERY WAY THIS CAN BE EMPTY IS ONE PAGE: not a main contact, the vault or
 * portal module closed, the switch off, nothing shown — the plane's one
 * quiet surface (`portalReadOrNull`), because the reason is a fact about
 * the agency.
 */
export default async function PortalLoginsPage() {
  const { principal, sessionId, name } = await requirePortalContext();
  const t = await getTranslations("portal.logins");

  const shown = await loginsShown(principal);
  // Null for a DENIAL; otherwise open, waiting for a code, or closed.
  const state = shown
    ? await portalReadOrNull("readPortalLoginsDoor", () => readPortalLoginsDoor({ principal, sessionId }))
    : null;
  const door = state?.state === "open" ? state.door : null;
  const logins = door
    ? await portalReadOrNull("listPortalLogins", () => listPortalLogins(principal, door))
    : null;

  const msLeft = door ? msUntil(door.openUntil) : 0;

  return (
    <PortalFrame name={name} principal={principal} nav="logins">
      <Page width="form">
        <div className="flex flex-col gap-6">
          <PageHeader
            title={t("title")}
            description={t("description")}
            actions={
              door && logins ? <VaultLockTimer locksAt={door.openUntil.toISOString()} msLeft={msLeft} /> : undefined
            }
          />
          {state === null ? (
            <PortalTasksEmpty />
          ) : door && logins ? (
            <SectionCard contentClassName="p-0">
              <p className="hairline-b px-4 py-2 text-xs text-muted-foreground">{t("logged")}</p>
              <PortalLoginList logins={logins} />
            </SectionCard>
          ) : (
            <SectionCard>
              <LoginsDoor initialStep={state.state === "waiting" ? "code" : "password"} />
            </SectionCard>
          )}
        </div>
      </Page>
    </PortalFrame>
  );
}
