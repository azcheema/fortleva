import { getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { loadClient } from "../data";
import { ContactRowForm, CreateContactForm } from "./contact-forms";

/** Contacts tab: records list with inline edit + inline add (client:manage_contacts). No invites yet. */
export default async function ClientContactsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await loadClient(id);
  const t = await getTranslations("clients.contacts");
  const editable = client.caps.manageContacts && client.status === "ACTIVE";

  return (
    <div className="flex flex-col gap-6">
      {client.contacts.length === 0 ? (
        <EmptyState title={t("empty")} description={t("emptyDescription")} />
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {client.contacts.map((c) => (
            <ContactRowForm key={c.id} clientId={client.id} contact={c} editable={editable} />
          ))}
        </ul>
      )}
      {editable ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("add")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <CreateContactForm clientId={client.id} />
            <p className="text-xs text-muted-foreground">{t("portalHint")}</p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
