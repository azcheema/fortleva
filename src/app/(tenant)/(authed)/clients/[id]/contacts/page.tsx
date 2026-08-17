import { getTranslations } from "next-intl/server";

import { EmptyState, SectionCard } from "@/components/semantic";

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
            <EmptyState variant="empty" title={t("empty")} body={t("emptyDescription")} />
          </div>
        ) : (
          <>
            {/* The inline edit grid used to be labelled only by aria-label;
                the same labels are now visible above the columns. */}
            <div
              aria-hidden="true"
              className={`hairline-b hidden h-8 items-center px-3 eyebrow text-muted-foreground sm:grid ${CONTACT_GRID}`}
            >
              {headers.map((label) => (
                <span key={label} className="truncate">
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
        <SectionCard title={t("add")} description={t("portalHint")}>
          <CreateContactForm clientId={client.id} />
        </SectionCard>
      ) : null}
    </div>
  );
}
