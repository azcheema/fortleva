import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { Page, PageHeader, SectionCard } from "@/components/semantic";
import { VaultLockTimer } from "@/components/vault/vault-lock-timer";
import {
  listPortalLogins,
  listSealedPortalLogins,
  readPortalLoginsDoor,
  readSealedPortalState,
} from "@/modules/vault";
import { portalReadOrNull } from "@/portal";
import { requirePortalContext } from "@/portal/context";

import { shownToContact } from "../logins-shown";
import { PortalFrame } from "../portal-frame";
import { PortalTasksEmpty } from "../task-list";
import { LoginsDoor } from "./logins-door";
import { PortalLoginList } from "./login-list";
import { SealedSection } from "./sealed-section";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal.logins");
  return { title: t("title") };
}

/** How long the door has left, from this request's clock — handed to the lock timer (the staff vault's way). */
const msUntil = (at: Date): number => at.getTime() - Date.now();

/**
 * `/portal/logins` — THE LOGINS AN AGENCY KEEPS FOR ITS CLIENT (Phase 3V
 * slice 91; founder decisions C52 (d) and (k), C59 — and, since slice 93,
 * the SEALED ones: C52 (f)–(h), C61). Main contacts only.
 *   - The logins the agency SHOWS the client, while it has client logins
 *     switched on: behind the client's door — their portal password AND a
 *     code mailed each time — open for the staff window in this session.
 *   - The logins it keeps SEALED for them, whether or not it shows any
 *     (C61 (d)): a COUNT and the way to ask (C61 (a)); then where the ask
 *     stands; the confirmation after the silent wait, through the same
 *     door; and, while an ask has them open, the list behind the door.
 *
 * NO VIEW-AS TWIN, on purpose (C52: never under View-as): every read here
 * is bound to the portal SESSION (`requirePortalContext().sessionId`), which
 * a member looking through a contact does not have, and
 * `vault-boundary.test.ts` holds the door's, the list's and the sealed
 * broker's callers to this route. The nav entry still renders inertly
 * inside View-as's frame — it draws from a count, never from this page.
 *
 * EVERY WAY THIS CAN BE EMPTY IS ONE PAGE: not a main contact, the vault or
 * portal module closed, nothing shown and nothing sealed — the plane's one
 * quiet surface (`portalReadOrNull`), because the reason is a fact about
 * the agency.
 */
export default async function PortalLoginsPage() {
  const { principal, sessionId, name } = await requirePortalContext();
  const t = await getTranslations("portal.logins");
  const ctx = { principal, sessionId };

  const shown = await shownToContact(principal);
  // Null for a DENIAL, or no standing; otherwise where the sealed logins stand.
  const sealed = await portalReadOrNull("readSealedPortalState", () => readSealedPortalState(ctx));
  const sealedHere = sealed !== null && (sealed.count > 0 || sealed.ask !== null);
  const sealedKind = sealed?.ask?.state.kind ?? null;
  // The door has a sealed purpose: the logins are open, or a confirmation is due.
  const sealedNeedsDoor = sealedKind === "open" || sealedKind === "confirmable";

  // Null for a DENIAL; otherwise open, waiting for a code, or closed.
  const state =
    shown || sealedNeedsDoor ? await portalReadOrNull("readPortalLoginsDoor", () => readPortalLoginsDoor(ctx)) : null;
  const door = state?.state === "open" ? state.door : null;
  const logins = door && shown ? await portalReadOrNull("listPortalLogins", () => listPortalLogins(principal, door)) : null;
  const opened =
    door && sealedKind === "open"
      ? await portalReadOrNull("listSealedPortalLogins", () => listSealedPortalLogins(ctx, door))
      : null;

  const msLeft = door ? msUntil(door.openUntil) : 0;
  const nothing = state === null && !sealedHere;

  return (
    <PortalFrame name={name} principal={principal} nav="logins">
      <Page width="form">
        <div className="flex flex-col gap-6">
          <PageHeader
            title={t("title")}
            description={t("description")}
            actions={door ? <VaultLockTimer locksAt={door.openUntil.toISOString()} msLeft={msLeft} /> : undefined}
          />
          {nothing ? <PortalTasksEmpty /> : null}
          {state !== null && !door ? (
            <SectionCard>
              <LoginsDoor initialStep={state.state === "waiting" ? "code" : "password"} />
            </SectionCard>
          ) : null}
          {door && logins && logins.length > 0 ? (
            <SectionCard contentClassName="p-0">
              <p className="hairline-b px-4 py-2 text-xs text-muted-foreground">{t("logged")}</p>
              <PortalLoginList logins={logins} kind="shown" />
            </SectionCard>
          ) : null}
          {sealedHere && sealed ? <SealedSection state={sealed} doorOpen={door !== null} opened={opened} /> : null}
        </div>
      </Page>
    </PortalFrame>
  );
}
