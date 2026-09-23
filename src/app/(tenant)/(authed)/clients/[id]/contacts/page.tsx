import { PlusIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";

import { loadClient } from "../data";
import { ContactRowForm, CreateContactForm } from "./contact-forms";
import { CONTACT_GRID } from "./grid";

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
 * So `manageable` (the permission alone) gates the verbs that TAKE
 * ACCESS AWAY, and `editable` (permission plus a live client) still
 * gates everything that adds or changes: the add card, the inline field
 * editors, and Invite — which `inviteContact` refuses on an archived
 * client anyway (§3.1: hidden, never disabled). Deleting the record
 * stays on `manageable` too, because erasure must not be blocked by an
 * archive either. Found by this slice's security review.
 */
export default async function ClientContactsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await loadClient(id);
  const t = await getTranslations("clients.contacts");
  const manageable = client.caps.manageContacts;
  const editable = manageable && client.status === "ACTIVE";

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
                  editable={editable}
                  manageable={manageable}
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
          description={t("portalHint")}
        >
          <CreateContactForm clientId={client.id} />
        </SectionCard>
      ) : null}
    </div>
  );
}
