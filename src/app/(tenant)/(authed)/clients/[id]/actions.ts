"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { assignMemberToClient, unassignMemberFromClient } from "@/clients/assignments";
import {
  inviteContact,
  setContactPortalAccess,
  type PortalAccessAction,
} from "@/clients/contact-access";
import {
  archiveClient,
  createContact,
  deleteContact,
  unarchiveClient,
  updateClient,
  updateClientNotes,
  updateContact,
  type ClientCardPatch,
} from "@/clients/service";
import { dateField, field, has, runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import { createProject } from "@/projects/service";
import { createService, deleteService, endService } from "@/services/service";

/**
 * Server actions for /clients/[id]/*. Every one derives tenant + actor
 * from the session and lets the service authorize + scope + audit in
 * one transaction; here we only parse the form and pick the message.
 */

const uuid = z.uuid();
const VAT_PROFILES = ["SE_DOMESTIC", "EU_REVERSE_CHARGE", "OUTSIDE_SCOPE"] as const;

const ctxOf = async () => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

const path = (clientId: string, sub = "") => `/clients/${clientId}${sub}`;

const invalid = async (): Promise<FormResult> => ({
  ok: false,
  message: (await getTranslations("common"))("invalidInput"),
});

// ── Company card (AutoForm posts the whole card; the service writes what changed) ──

export async function updateClientCardAction(formData: FormData): Promise<FormResult> {
  const clientId = uuid.safeParse(formData.get("clientId"));
  if (!clientId.success) return invalid();
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const patch: ClientCardPatch = {};
  const text = (name: keyof ClientCardPatch & string) => {
    if (has(formData, name)) (patch as Record<string, string | null>)[name] = field(formData, name);
  };
  for (const f of [
    "name",
    "orgNr",
    "vatNumber",
    "countryCode",
    "addressLine1",
    "addressLine2",
    "postalCode",
    "city",
    "billingEmail",
    "invoiceLocale",
  ] as const) {
    text(f);
  }
  if (has(formData, "vatProfile")) {
    const v = field(formData, "vatProfile");
    patch.vatProfile = VAT_PROFILES.includes(v as (typeof VAT_PROFILES)[number])
      ? (v as (typeof VAT_PROFILES)[number])
      : null;
  }
  const r = await runForm(path(clientId.data), async () => {
    await updateClient(ctx, clientId.data, patch);
    return tCommon("saved");
  });
  if (r.ok) revalidatePath(path(clientId.data), "layout");
  return r;
}

export async function updateClientNotesAction(formData: FormData): Promise<FormResult> {
  const clientId = uuid.safeParse(formData.get("clientId"));
  if (!clientId.success) return invalid();
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const r = await runForm(path(clientId.data), async () => {
    await updateClientNotes(ctx, clientId.data, field(formData, "internalNotes"));
    return tCommon("saved");
  });
  if (r.ok) revalidatePath(path(clientId.data));
  return r;
}

export async function setClientArchivedAction(
  clientId: string,
  archived: boolean,
): Promise<FormResult> {
  if (!uuid.safeParse(clientId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("clients.overview");
  const r = await runForm(path(clientId), async () => {
    if (archived) {
      await archiveClient(ctx, clientId);
      return t("archivedToast");
    }
    await unarchiveClient(ctx, clientId);
    return t("restoredToast");
  });
  if (r.ok) {
    revalidatePath(path(clientId), "layout");
    revalidatePath("/clients");
  }
  return r;
}

// ── Assignments ─────────────────────────────────────────────────────

export async function assignClientMemberAction(
  clientId: string,
  memberId: string,
  memberName: string,
): Promise<FormResult> {
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(memberId).success) return invalid();
  const { tenantId, actor } = await ctxOf();
  const t = await getTranslations("assignments");
  const r = await runForm(path(clientId), async () => {
    await assignMemberToClient({ tenantId, actor, memberId, clientId });
    return t("added", { name: memberName });
  });
  if (r.ok) revalidatePath(path(clientId), "layout");
  return r;
}

export async function unassignClientMemberAction(
  clientId: string,
  memberId: string,
  memberName: string,
): Promise<FormResult> {
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(memberId).success) return invalid();
  const { tenantId, actor } = await ctxOf();
  const t = await getTranslations("assignments");
  const r = await runForm(path(clientId), async () => {
    await unassignMemberFromClient({ tenantId, actor, memberId, clientId });
    return t("removed", { name: memberName });
  });
  if (r.ok) revalidatePath(path(clientId), "layout");
  return r;
}

// ── Contacts (records) ──────────────────────────────────────────────

const profileOf = (v: string | null) =>
  v === "CONTACT_PRIMARY" ? "CONTACT_PRIMARY" : "CONTACT_COLLABORATOR";

export async function createContactAction(
  _prev: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const clientId = uuid.safeParse(formData.get("clientId"));
  if (!clientId.success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("clients.contacts");
  const name = field(formData, "name") ?? "";
  // THE TICK IS THE SHORTCUT FOR THE COMMON CASE (founder decision,
  // 2026-09-23) — the row still carries its own Invite verb, because
  // every contact that exists today was added before there was anything
  // to tick. A checkbox posts nothing when it is clear, so PRESENCE is
  // the value, which is exactly what `has()` means and what this file
  // already uses seven times over.
  const invite = has(formData, "invite");
  const r = await runForm(path(clientId.data, "/contacts"), async () => {
    const created = await createContact(ctx, clientId.data, {
      name,
      email: field(formData, "email") ?? "",
      title: field(formData, "title"),
      phone: field(formData, "phone"),
      portalProfile: profileOf(field(formData, "portalProfile")),
    });
    if (!invite) return t("added", { name: name.trim() });
    // **TWO CALLS, TWO TRANSACTIONS, TWO AUDIT ROWS** (`contact.created`
    // then `contact.invited`), rather than an `invite` flag threaded
    // through `createContact`. The two acts are genuinely separate — one
    // records a person, the other sends them a credential-bearing link —
    // and folding them together would put a mail send inside the
    // record-keeping path for every caller of it, including the ones
    // that must never send anything.
    const { mailed } = await inviteContact(ctx, created.id);
    // Recorded, invited, and possibly not DELIVERED — `inviteContact`
    // reports a send failure rather than throwing it, because the
    // invitation itself has committed by then. Resend is the recovery and
    // it lives in the row's own menu.
    return mailed
      ? t("addedAndInvited", { name: name.trim() })
      : t("addedNotSent", { name: name.trim() });
  });
  // **REVALIDATED EVEN ON FAILURE, and the tick is why.** `createContact`
  // and `inviteContact` are two transactions, so the second can refuse
  // after the first has committed — a contact who exists on a page that
  // was never re-rendered. The member then reads "could not add" over a
  // list that does not show the person, and adds them again, which fails
  // on the email unique. A revalidation costs one render and makes the
  // screen agree with the database whatever happened. Raised by this
  // slice's review.
  revalidatePath(path(clientId.data), "layout");
  return r;
}

/**
 * INVITE, AND RESEND, AND THEY ARE THE SAME CALL. `inviteContact`'s
 * allowlist admits NO_ACCESS (a first invitation) and INVITED (the
 * legitimate resend) and supersedes any live token, so a second code
 * path for "resend" would either mint two live invitations or trip the
 * `contact_invite_one_live_idx` partial unique. The row picks the LABEL
 * from the status; the server sees one verb.
 */
export async function inviteContactAction(
  clientId: string,
  contactId: string,
): Promise<FormResult> {
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(contactId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("clients.contacts");
  const r = await runForm(path(clientId, "/contacts"), async () => {
    // `mailed` is false when the transport refused AFTER the invitation
    // committed. Saying "sent" then would be a lie the member could only
    // discover by asking the client whether anything arrived.
    const { mailed } = await inviteContact(ctx, contactId);
    return mailed ? t("invited") : t("invitedNotSent");
  });
  // "layout", not the tab: `portalStatus` is read by the client's Portal
  // tab and by View-as-Contact as well as by this list.
  if (r.ok) revalidatePath(path(clientId), "layout");
  return r;
}

/**
 * PAUSE, RESUME, REMOVE — the founder's three verbs, one action.
 *
 * The success message is picked by the verb, and the REMOVE one carries
 * `releasedTasks`: how many tasks came back to the team. That number is
 * knowable only after the act — the service returns it — which is why it
 * is reported here rather than asked in the row's confirmation, where
 * UI.md §5.9 gives a destructive verb one short line and no modal.
 */
export async function setContactPortalAccessAction(
  clientId: string,
  contactId: string,
  action: PortalAccessAction,
): Promise<FormResult> {
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(contactId).success) return invalid();
  if (action !== "PAUSE" && action !== "RESUME" && action !== "REMOVE") return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("clients.contacts");
  const r = await runForm(path(clientId, "/contacts"), async () => {
    const result = await setContactPortalAccess(ctx, contactId, action);
    if (action === "PAUSE") return t("accessPaused");
    if (action === "RESUME") return t("accessResumed");
    // A SEPARATE SENTENCE FOR ZERO rather than a `=0` plural branch, and
    // the catalogue's parity test is why: `icuArgs` there matches the
    // first token inside any `{...}`, so a branch body beginning with a
    // WORD reads as an ICU argument name and "no"/"inga" fail as a
    // mismatched argument between locales. Every plural in this
    // catalogue therefore starts its branches with a digit or `#`. The
    // branch belongs in the action anyway: "no tasks came back" is a
    // different thing to say, not a different number.
    return result.releasedTasks === 0
      ? t("accessRevokedNone")
      : t("accessRevoked", { count: result.releasedTasks });
  });
  if (r.ok) revalidatePath(path(clientId), "layout");
  return r;
}

/**
 * An ABSENT field is "not submitted", never "erase this" (WORKLIST
 * hazard H1). `updateContact` already treats its patch as partial —
 * `"name" in patch` — so the guard belongs here, in the same shape
 * `updateClientCardAction` uses. Without it a form that ever posts a
 * subset of its fields silently wipes the other four.
 */
export async function updateContactAction(formData: FormData): Promise<FormResult> {
  const clientId = uuid.safeParse(formData.get("clientId"));
  const contactId = uuid.safeParse(formData.get("contactId"));
  if (!clientId.success || !contactId.success) return invalid();
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const patch: Parameters<typeof updateContact>[2] = {};
  if (has(formData, "name")) patch.name = field(formData, "name") ?? "";
  if (has(formData, "email")) patch.email = field(formData, "email") ?? "";
  if (has(formData, "title")) patch.title = field(formData, "title");
  if (has(formData, "phone")) patch.phone = field(formData, "phone");
  if (has(formData, "portalProfile")) {
    patch.portalProfile = profileOf(field(formData, "portalProfile"));
  }
  const r = await runForm(path(clientId.data, "/contacts"), async () => {
    await updateContact(ctx, contactId.data, patch);
    return tCommon("saved");
  });
  if (r.ok) revalidatePath(path(clientId.data, "/contacts"));
  return r;
}

export async function deleteContactAction(clientId: string, contactId: string): Promise<FormResult> {
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(contactId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("clients.contacts");
  const r = await runForm(path(clientId, "/contacts"), async () => {
    await deleteContact(ctx, contactId);
    return t("removed");
  });
  if (r.ok) revalidatePath(path(clientId), "layout");
  return r;
}

// ── Projects tab: inline create ─────────────────────────────────────

export async function createClientProjectAction(
  _prev: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const clientId = uuid.safeParse(formData.get("clientId"));
  if (!clientId.success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("projects.create");
  const r = await runForm(path(clientId.data, "/projects"), async () => {
    const created = await createProject(ctx, {
      clientId: clientId.data,
      key: field(formData, "key") ?? "",
      name: field(formData, "name") ?? "",
    });
    return t("created", { key: created.key });
  });
  if (r.ok) {
    revalidatePath(path(clientId.data), "layout");
    revalidatePath("/projects");
  }
  return r;
}

// ── Services (records) ──────────────────────────────────────────────

const KINDS = ["ONE_TIME", "RECURRING"] as const;
const INTERVALS = ["MONTHLY", "QUARTERLY", "YEARLY"] as const;

export async function createServiceAction(
  _prev: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const clientId = uuid.safeParse(formData.get("clientId"));
  if (!clientId.success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("clients.services");
  const kindRaw = field(formData, "kind");
  const kind = KINDS.includes(kindRaw as (typeof KINDS)[number])
    ? (kindRaw as (typeof KINDS)[number])
    : "ONE_TIME";
  const intervalRaw = field(formData, "billingInterval");
  const billingInterval = INTERVALS.includes(intervalRaw as (typeof INTERVALS)[number])
    ? (intervalRaw as (typeof INTERVALS)[number])
    : null;
  const projectRaw = field(formData, "projectId");
  const projectId = projectRaw && uuid.safeParse(projectRaw).success ? projectRaw : null;
  const name = field(formData, "name") ?? "";
  const r = await runForm(path(clientId.data), async () => {
    await createService(ctx, {
      clientId: clientId.data,
      projectId,
      name,
      kind,
      billingInterval,
      priceExVat: field(formData, "priceExVat"),
      currency: field(formData, "currency"),
      renewsAt: dateField(formData, "renewsAt"),
    });
    return t("added", { name: name.trim() });
  });
  // "layout": services are rendered on the Agreements tab (2T), not the overview path.
  if (r.ok) revalidatePath(path(clientId.data), "layout");
  return r;
}

export async function endServiceAction(clientId: string, serviceId: string): Promise<FormResult> {
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(serviceId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("clients.services");
  const r = await runForm(path(clientId), async () => {
    await endService(ctx, serviceId);
    return t("ended");
  });
  if (r.ok) revalidatePath(path(clientId), "layout");
  return r;
}

export async function deleteServiceAction(clientId: string, serviceId: string): Promise<FormResult> {
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(serviceId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("clients.services");
  const r = await runForm(path(clientId), async () => {
    await deleteService(ctx, serviceId);
    return t("deleted");
  });
  if (r.ok) revalidatePath(path(clientId), "layout");
  return r;
}
