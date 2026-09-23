import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { PortalLoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.portal");
  return { title: t("title") };
}

/**
 * `/portal/login` — the portal's sign-in surface, and a real form since
 * the invite flow's surfaces landed.
 *
 * **IT WAS A LOCKED SHELL UNTIL NOW, and the reason it stopped being one
 * is written in its own old docblock: "there is no form here yet,
 * because there is no invite flow yet".** Both halves of that have now
 * shipped, and leaving it locked would have made the invitation a
 * one-shot door — `contact_session` expires in two days, so a contact
 * who accepted, closed the browser and came back on Thursday would have
 * had no way in and no way to be let in (`inviteContact` admits only
 * NO_ACCESS and INVITED, so re-inviting an ACTIVE contact is refused).
 * It is also the only destination the acceptance page's dead-end state
 * can offer, and `PageState` requires one.
 *
 * The form is a client module of its own so that this file can stay a
 * server component and keep its `generateMetadata` — the convention
 * every page in the product follows. It reads `useSearchParams`, so it
 * needs the `<Suspense>` boundary.
 */
export default function PortalLogin() {
  return (
    <Suspense>
      <PortalLoginForm />
    </Suspense>
  );
}
