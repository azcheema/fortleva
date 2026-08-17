import { PlusIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";

import { loadClient } from "../data";
import { ContactRowForm, CreateContactForm } from "./contact-forms";
import { CONTACT_GRID } from "./grid";

/** Contacts tab: records list with inline edit + inline add (client:manage_contacts). No invites yet. */
export default async function ClientContactsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await loadClient(id);
  const t = await getTranslations("clients.contacts");
  const editable = client.caps.manageContacts && client.status === "ACTIVE";

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
                <ContactRowForm key={c.id} clientId={client.id} contact={c} editable={editable} />
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
