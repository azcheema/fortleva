import { PlusIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { readContactSignIns } from "@/clients/contact-sign-ins";
import type { ContactRow } from "@/clients/service";
import { EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { withTenant } from "@/db";
import { resolveTimeZone } from "@/i18n/resolve";
import { formatDate } from "@/lib/format";
import { requireTenantContext } from "@/members/tenant-context";
import { undeliverableAmong } from "@/notify/undeliverable";

import { loadClient } from "../data";
import { ContactRowForm, CreateContactForm, type ContactRowAbilities, type SignInLine } from "./contact-forms";
import { CONTACT_GRID } from "./grid";

const NBSP = String.fromCharCode(0xa0);

/**
 * Contacts tab: the records list with inline edit and inline add, plus
 * the portal access verbs (`client:manage_contacts`).
 *
 * **TWO GATES, NOT ONE, AND ARCHIVING IS WHY.** `editable` has always
 * meant "this client is live and you may change its records", and it
 * gated the whole row menu — so archiving a client REMOVED THE ONLY
 * CONTROL THAT ENDS PORTAL ACCESS while leaving that access live. The
 * contact could still sign in; `portal_gate` does not consult the
 * client's archived flag; and the member had no verb to cut them off
 * with. An archive is very often exactly the moment somebody wants that
 * verb — the engagement is over.
 *
 * So the verbs that TAKE ACCESS AWAY ignore the client's status, and
 * everything that adds or changes — the add card, the inline field
 * editors, and Invite, which `inviteContact` refuses on an archived client
 * anyway (§3.1: hidden, never disabled) — needs a live client. Deleting
 * the record ignores the status too, because erasure must not be blocked
 * by an archive either. Found by this slice's security review.
 *
 * **AND THE RECORD IS NOT THE PORTAL** (OPEN_QUESTIONS C48, 2026-09-29).
 * `client:manage_contacts` is a PORTAL-module code. Adding, editing and
 * deleting a contact RECORD check it at gate 4 only
 * (`authorizeContactRecordWrite`, `caps.manageContactRecords`), so they
 * work with the portal switched off; the portal verbs and the sign-in
 * line check it on all four gates (`caps.manageContacts`) and go with the
 * portal. `ContactRowAbilities` is the four answers per row.
 */
export default async function ClientContactsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await loadClient(id);
  const t = await getTranslations("clients.contacts");
  const live = client.status === "ACTIVE";
  const records = client.caps.manageContactRecords;
  const portal = client.caps.manageContacts;
  const editable = records && live;
  const can: ContactRowAbilities = {
    edit: editable,
    erase: records,
    invite: portal && live,
    takeAccess: portal,
  };

  // "Last signed in …" is for the people who manage this client's portal
  // access (OPEN_QUESTIONS C46) — `null` for anyone else, and then no row
  // draws the line at all. After `loadClient`, which 404s first.
  // `portal` is the same four gates (minus the scope, which `loadClient`
  // already passed), so without it — or with no contacts to show — the
  // read is not worth a transaction.
  const { membership, actor } = await requireTenantContext();
  const signIns =
    portal && client.contacts.length > 0
      ? await readContactSignIns({ tenantId: membership.tenantId, actor }, client.id)
      : null;
  // "Emails to this address aren't being delivered" (slice 103, C71 (d)) —
  // for EVERY reader of the tab, not only the portal's managers: whoever can
  // see an address may know that mail to it does not arrive. The addresses
  // came through `loadClient`'s gates; this asks only whether each is blocked.
  const undeliverable =
    client.contacts.length > 0
      ? await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
          undeliverableAmong(
            tx,
            client.contacts.map((c) => c.email),
          ),
        )
      : new Set<string>();
  const locale = await getLocale();
  // The member's zone (UI.md §8): a sign-in at 00:30 in Stockholm is
  // that day there, not the day before in UTC.
  const timeZone = await resolveTimeZone();
  const signInLine = (c: ContactRow): SignInLine | null => {
    const state = signIns?.get(c.id);
    if (state === undefined) return null;
    switch (state.kind) {
      case "at":
        return {
          text: t("signIn.at", {
            // No-break spaces inside the date: on a phone the sentence may
            // take two lines, and it must break before the date, not in it.
            date: formatDate(locale, state.at, { year: "numeric", month: "short", day: "numeric", timeZone }).replace(
              /\s/gu,
              NBSP,
            ),
          }),
        };
      case "never":
        return { text: t("signIn.never") };
      case "notWithin":
        return { text: t("signIn.notWithinYear") };
      case "none":
        return { text: null };
    }
  };

  const headers = [
    t("name"),
    t("email"),
    t("jobTitle"),
    t("phone"),
    t("profile"),
    t("columns.status"),
  ];

  return (
    <div className="flex flex-col gap-6">
      <SectionCard title={t("title")} contentClassName="p-0">
        {client.contacts.length === 0 ? (
          <div className="px-4">
            {editable ? (
              <EmptyState
                variant="empty"
                icon={UsersIcon}
                title={t("empty")}
                body={t("emptyDescription")}
                action={
                  <Button asChild size="sm">
                    <Link href="#new-contact">
                      <PlusIcon />
                      {t("add")}
                    </Link>
                  </Button>
                }
              />
            ) : (
              <EmptyState
                variant="forbidden"
                icon={UsersIcon}
                title={t("emptyReadOnly")}
                body={t("emptyReadOnlyDescription")}
              />
            )}
          </div>
        ) : (
          <>
            {/* The values are read-first text now; the column labels are
                what tells you which value is which. */}
            <div
              aria-hidden="true"
              className={`hairline-b hidden h-8 items-center px-3 eyebrow text-muted-foreground sm:grid ${CONTACT_GRID}`}
            >
              {headers.map((label) => (
                // The same 10px inset the resting value carries, so a
                // label sits directly above the value it names.
                <span key={label} className="truncate px-2.5">
                  {label}
                </span>
              ))}
            </div>
            <ul className="divide-y divide-border">
              {client.contacts.map((c) => (
                <ContactRowForm
                  key={c.id}
                  clientId={client.id}
                  contact={c}
                  signIn={signInLine(c)}
                  undeliverable={undeliverable.has(c.email.trim().toLowerCase())}
                  can={can}
                />
              ))}
            </ul>
          </>
        )}
      </SectionCard>

      {editable ? (
        <SectionCard
          id="new-contact"
          className="scroll-mt-16"
          title={t("add")}
          // The hint is about the invite tick, which is not there without
          // the portal verbs (C48).
          description={can.invite ? t("portalHint") : undefined}
        >
          <CreateContactForm clientId={client.id} canInvite={can.invite} />
        </SectionCard>
      ) : null}
    </div>
  );
}
