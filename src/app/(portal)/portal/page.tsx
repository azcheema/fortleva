import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requirePortalContext } from "@/portal/context";

import { PortalHome } from "./portal-home";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal");
  return { title: t("shortTitle") };
}

/**
 * `/portal` — THE FIRST REAL PORTAL ROUTE (memo slice 3), and since
 * slice 5 a four-line route.
 *
 * What it proves is the whole vertical: a contact session →
 * `requirePortalContext()` → `authorizePortal()` → `withPortalRead`
 * under the contact principal → an allow-listed projection → a page
 * that can render nothing else. Everything BELOW the principal moved
 * into `<PortalHome>` when View-as-Contact landed, so that the member's
 * "view as client" surface and this page are not two renderings of one
 * idea but one component called twice. SECURITY.md §5.1 gives the
 * reason in six words — *a separate preview renderer is how previews
 * lie* — and `e2e/view-as.spec.ts` compares the two outputs byte for
 * byte.
 *
 * SO THE ONLY THING THIS FILE STILL DECIDES IS WHO IS ASKING, which is
 * the one thing the two routes may legitimately differ on.
 *
 * **ADMISSION IS THE EXCEPTION** to the "every refusal renders
 * identically" rule, and the first draft of this comment got it wrong
 * in a way both fresh reviews caught independently. A SUSPENDED contact
 * does not land on an empty page here: `requirePortalContext()` runs
 * first, `requirePortalContact()` redirects to /portal/login on any
 * gate verdict but "ok" (`portalGateDecision` → "not_active" /
 * "unverified" / "incomplete"), and `authorizePortal`'s own `FORBIDDEN
 * "contact is not ACTIVE"` is therefore unreachable from a page at all.
 * That is the right behaviour — a contact whose access was revoked must
 * be signed out, not left holding a usable session in front of an empty
 * page — and what it discloses is a fact about the READER, which they
 * need in order to ask for it back and which signing in would tell them
 * anyway. The rule is therefore: **every authorization denial after
 * admission is identical; admission itself signs the contact out.**
 */
export default async function PortalHomePage() {
  const { principal, name } = await requirePortalContext();
  return <PortalHome principal={principal} name={name} />;
}
