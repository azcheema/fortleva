"use client";

import { MailIcon, PauseIcon, PlayIcon, Trash2Icon, UserMinusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { Field, FormMessage, InlineEdit, RowActions, StatusBadge } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useRun } from "@/components/use-run";
// THE LEAF, NEVER THE SERVICE. `@/clients/contact-access` reaches
// `withTenant` → Prisma → `pg`, and this is a browser module.
import { isInvitableStatus } from "@/clients/portal-status";
import type { ContactRow } from "@/clients/service";
import type { RowAction } from "@/components/semantic";
import type { FormResult } from "@/lib/server-actions";

import {
  createContactAction,
  deleteContactAction,
  inviteContactAction,
  setContactPortalAccessAction,
  updateContactAction,
} from "../actions";

import { CONTACT_GRID } from "./grid";

const PROFILES = ["CONTACT_PRIMARY", "CONTACT_COLLABORATOR"] as const;

/**
 * The "Last signed in …" line under the address, a whole sentence
 * formatted on the server in the member's locale and zone, its date
 * unbreakable (a phone's narrow address track wraps it as "Last signed
 * in / Sep 29, 2026", never mid-date). `text: null` for a contact who
 * was never given access — the status chip already says so, and the
 * line keeps its height, so on a desktop every row stays one height.
 */
export type SignInLine = { readonly text: string | null };

/**
 * One contact row. A list of people is CONTENT (founder mandate 1): the
 * five permanently-mounted inputs are gone, every value renders as
 * text, and a click, Enter, Space or F2 turns one into the control it
 * already looked like. Auto-save semantics are untouched — the same
 * `<Input>` / `<NativeSelect>` mount inside the same `<AutoForm>`, and
 * `<InlineEdit>` keeps a hidden input at rest so the posted FormData is
 * byte-identical (WORKLIST hazard H1).
 *
 * The remove verb moved into the row's `⋯` menu: a solid red button on
 * every row of every table was the highest-chroma object on the page.
 * Since the invite flow's surfaces it shares that menu with the portal
 * verbs — Invite, Resend, Pause, Resume, End access — which are offered
 * strictly by `portalStatus`; the table below `items` is the map.
 */
export function ContactRowForm({
  clientId,
  contact,
  signIn,
  editable,
  manageable,
}: {
  clientId: string;
  contact: ContactRow;
  /** `null` when the reader may not see sign-ins (C46): no line at all. */
  signIn: SignInLine | null;
  /** Permission AND a live client: may change records, may invite. */
  editable: boolean;
  /**
   * `client:manage_contacts` on all four gates, whatever the client's
   * status: may take access away even on an archived client. Never feed
   * it the bare permission — the portal module switched off must hide it.
   */
  manageable: boolean;
}) {
  const t = useTranslations("clients.contacts");
  const tCommon = useTranslations("common");
  // THE SHARED HOOK, not a fifth copy of it. `useRun` exists because an
  // action failure must never look like a revert (AGENTS.md), and it had
  // already been extracted once for that reason; a review of this file's
  // hand-rolled twin is what moved it to `src/components`.
  const { run } = useRun();

  const profiles = PROFILES.map((p) => ({ value: p, label: t(`profiles.${p}`) }));
  const profileLabel = t(`profiles.${contact.portalProfile}`);
  const status = <StatusBadge domain="portalStatus" value={contact.portalStatus} />;

  /**
   * THE VERBS ARE A FUNCTION OF `portalStatus`, and the mapping is the
   * service's own allowlist read backwards — §3.1's "hidden, never
   * disabled" applied so that no control is drawn which
   * `contact-access.ts` would then refuse:
   *
   * | status | offered | needs |
   * |---|---|---|
   * | NO_ACCESS | Invite | a live client |
   * | NO_ACCESS | Delete record | the permission |
   * | INVITED | Resend | a live client |
   * | INVITED | End access | the permission |
   * | ACTIVE | Pause · End access | the permission |
   * | SUSPENDED | Resume · End access | the permission |
   * | REVOKED | Invite | a live client |
   * | REVOKED | Delete record | the permission |
   *
   * The right-hand column is the fix for an archived client losing the
   * only control that ends portal access — see `page.tsx` for why the
   * page now computes two gates.
   *
   * **A REVOKED ROW OFFERS INVITE AGAIN** (founder decision, 2026-09-23
   * — OPEN_QUESTIONS C28), which is why its two rows above are identical
   * to NO_ACCESS's. It used to offer nothing but Delete, and that made
   * ending somebody's access an absorbing state: a client contact who
   * came back a year later could not be given access and could not be
   * erased either, because `deleteContact` refuses anybody who has
   * written in the portal. The verb simply was not there and nothing
   * said why.
   *
   * It mints a FRESH invitation rather than resending one — hence the
   * label, and hence `resend` staying bound to INVITED alone. Their
   * released assignments do not come back with it.
   *
   * **INVITE AND RESEND ARE ONE CALL.** The label differs because the
   * member's act differs; the server sees `inviteContact` either way,
   * and it supersedes any live token so a forwarded link dies the moment
   * a new one is sent. A second code path would either mint two live
   * invitations or trip the partial unique.
   *
   * **DELETE IS NOT REVOKE**, and the two now sit one above the other:
   * `deleteContact` erases the record and admits only NO_ACCESS or
   * REVOKED, so on anyone who can still sign in the only offered
   * destructive verb is the one that cuts them off.
   *
   * The questions are SHORT because UI.md §5.9 gives a destructive verb
   * one line in the row and no modal. How many tasks actually came back
   * is in the success toast — which is also the only place the number
   * can be honest, since `setContactPortalAccess` counts them as it
   * releases them.
   */
  const items: RowAction[] = [];
  // INVITING NEEDS A LIVE CLIENT (`editable`) — `inviteContact` refuses
  // an archived one, so offering it there would be a control that only
  // ever produces a refusal.
  if (editable && isInvitableStatus(contact.portalStatus)) {
    // `resend` is INVITED alone: a REVOKED row gets a FRESH invitation,
    // so it reads "Invite", not "Send the invitation again".
    const resend = contact.portalStatus === "INVITED";
    items.push({
      key: resend ? "resend" : "invite",
      label: resend ? t("resend") : t("invite"),
      icon: MailIcon,
      onSelect: () => run(() => inviteContactAction(clientId, contact.id)),
    });
  }
  // EVERYTHING BELOW NEEDS ONLY THE PERMISSION, because every one of them
  // TAKES ACCESS AWAY or erases a record, and an archived client must not
  // be a client whose people cannot be cut off.
  if (manageable) {
    if (contact.portalStatus === "ACTIVE") {
      // NO `confirm`, and its absence is deliberate rather than an
      // omission. `rowActionNeedsConfirm` asks only for a `tone:
      // "danger"` item, so a `confirm` on this one was a string nothing
      // read — the menu click acted immediately and the question never
      // appeared. The verb does not earn the danger weight either: it is
      // the founder's "they will be back", it keeps their tasks, and
      // Resume is one click in the same menu. So it acts on one click,
      // like Resume, and the audit row is what records that it happened.
      items.push({
        key: "pause",
        label: t("pauseAccess"),
        icon: PauseIcon,
        onSelect: () => run(() => setContactPortalAccessAction(clientId, contact.id, "PAUSE")),
      });
    }
    if (contact.portalStatus === "SUSPENDED") {
      items.push({
        key: "resume",
        label: t("resumeAccess"),
        icon: PlayIcon,
        onSelect: () => run(() => setContactPortalAccessAction(clientId, contact.id, "RESUME")),
      });
    }
    if (
      contact.portalStatus === "INVITED" ||
      contact.portalStatus === "ACTIVE" ||
      contact.portalStatus === "SUSPENDED"
    ) {
      items.push({
        key: "revoke",
        label: t("revokeAccess"),
        icon: UserMinusIcon,
        tone: "danger",
        confirm: t("revokeConfirm"),
        onSelect: () => run(() => setContactPortalAccessAction(clientId, contact.id, "REMOVE")),
      });
    }
    // NO_ACCESS **or REVOKED**, matching `deleteContact`'s own guard:
    // both mean "no live access". Until the invite slice, REVOKED was
    // unreachable; the moment `portalStatus` had a writer, gating on
    // NO_ACCESS alone made the erasure control invisible for exactly the
    // people an erasure request is about — a member ends access and the
    // Delete action disappears. Found by a fresh code review.
    //
    // It is offered even to a contact who has WRITTEN in the portal,
    // where `deleteContact` always refuses. Hiding it would need a
    // per-contact "has written anything" count on the hottest read of
    // this page, and the refusal says the answer a member needs either
    // way: the record is kept and cannot be deleted. **It deliberately
    // does NOT advise ending their access** — that guard sits below the
    // status check in `deleteContact`, so it is reachable only for a
    // NO_ACCESS or REVOKED contact, who has no access to end.
    if (contact.portalStatus === "NO_ACCESS" || contact.portalStatus === "REVOKED") {
      items.push({
        key: "remove",
        label: t("removeContact"),
        icon: Trash2Icon,
        tone: "danger",
        confirm: t("removeConfirm"),
        onSelect: () => run(() => deleteContactAction(clientId, contact.id)),
      });
    }
  }

  const trailing = (
    <span className="flex min-w-0 items-center justify-between gap-2">
      {status}
      {items.length > 0 ? (
        <RowActions label={tCommon("actionsFor", { name: contact.name })} items={items} />
      ) : null}
    </span>
  );

  const emailField = (readOnly: boolean) => (
    <InlineEdit
      kind="text"
      name="email"
      value={contact.email}
      label={t("email")}
      placeholder={tCommon("notSet")}
      readOnly={readOnly}
      density="table"
      inputProps={{ required: true, inputMode: "email", autoComplete: "email" }}
      className={readOnly ? readOnlyClass : undefined}
    />
  );

  // With the sign-in line the address cell is two lines tall, so the row
  // aligns to the TOP: every value shares the first line, and the line
  // hangs under the address rather than pushing it above its neighbours.
  const align = signIn === null ? "items-center" : "items-start";
  // Top-aligned, a READ-ONLY value (an archived client, seen by a manager)
  // is a bare 20px line beside the 28px chip-and-actions cell, so it sat
  // 4px high; `min-h-7` gives it the editable resting box's height. Only
  // with the line: a centred row never needed it.
  const readOnlyClass = signIn === null ? "px-2.5" : "min-h-7 px-2.5";

  const values = (readOnly: boolean) => (
    <>
      <InlineEdit
        kind="text"
        name="name"
        value={contact.name}
        label={t("name")}
        placeholder={tCommon("notSet")}
        readOnly={readOnly}
        density="table"
        inputProps={{ required: true }}
        controlClassName="font-medium"
        display={<span className="font-medium">{contact.name}</span>}
        className={readOnly ? readOnlyClass : undefined}
      />
      {signIn === null ? (
        emailField(readOnly)
      ) : (
        // UNDER THE ADDRESS, NOT A SEVENTH COLUMN. The card is capped near
        // 1030px and the six tracks are sized to their longest values
        // (`grid.ts`); a fixed track for the date truncated "PORTAL
        // PROFILE", the phone number and the name at 1440px. The address
        // is the widest track and the identity the person signs in with,
        // and a whole sentence needs no header — so no label trick for a
        // phone, where the headers are hidden, or for a screen reader,
        // for which the header row is `aria-hidden`.
        <div className="flex min-w-0 flex-col">
          {emailField(readOnly)}
          <span data-slot="contact-sign-in" className="min-h-4 px-2.5 text-xs text-muted-foreground">
            {signIn.text}
          </span>
        </div>
      )}
      <InlineEdit
        kind="text"
        name="title"
        value={contact.title ?? ""}
        label={t("jobTitle")}
        placeholder={tCommon("notSet")}
        readOnly={readOnly}
        density="table"
        className={readOnly ? readOnlyClass : undefined}
      />
      <InlineEdit
        kind="text"
        name="phone"
        value={contact.phone ?? ""}
        label={t("phone")}
        placeholder={tCommon("notSet")}
        readOnly={readOnly}
        density="table"
        controlClassName="num"
        display={<span className="num">{contact.phone}</span>}
        className={readOnly ? readOnlyClass : undefined}
      />
      <InlineEdit
        kind="select"
        name="portalProfile"
        value={contact.portalProfile}
        label={t("profile")}
        placeholder={profileLabel}
        options={profiles}
        readOnly={readOnly}
        density="table"
        // A setting, not a fact about the person: it reads at hint
        // weight until someone goes looking for it.
        display={<span className="text-xs text-muted-foreground">{profileLabel}</span>}
        className={readOnly ? readOnlyClass : undefined}
      />
    </>
  );

  if (!editable) {
    return (
      <li className={`grid ${CONTACT_GRID} ${align} px-3 py-1.5 text-sm`}>
        {values(true)}
        {trailing}
      </li>
    );
  }

  return (
    <li className="px-3 py-1.5">
      <AutoForm action={updateContactAction} className={`grid ${CONTACT_GRID} ${align}`}>
        <input type="hidden" name="clientId" value={clientId} />
        <input type="hidden" name="contactId" value={contact.id} />
        {values(false)}
        {trailing}
      </AutoForm>
    </li>
  );
}

/** Inline add: name + email required; Enter adds the next (UI.md rule 2). */
export function CreateContactForm({ clientId }: { clientId: string }) {
  const t = useTranslations("clients.contacts");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(
    createContactAction,
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message);
      formRef.current?.reset();
      nameRef.current?.focus();
    }
  }, [state]);
  return (
    <form ref={formRef} action={action} className="grid grid-cols-2 items-end gap-3 sm:grid-cols-6">
      <input type="hidden" name="clientId" value={clientId} />
      <Field label={t("name")} htmlFor="ct-name">
        <Input id="ct-name" ref={nameRef} name="name" required disabled={pending} />
      </Field>
      <Field label={t("email")} htmlFor="ct-email">
        <Input id="ct-email" name="email" type="email" required disabled={pending} />
      </Field>
      <Field label={t("jobTitle")} htmlFor="ct-title">
        <Input id="ct-title" name="title" disabled={pending} />
      </Field>
      <Field label={t("phone")} htmlFor="ct-phone">
        <Input id="ct-phone" name="phone" className="num" disabled={pending} />
      </Field>
      <Field label={t("profile")} htmlFor="ct-profile">
        <NativeSelect
          id="ct-profile"
          name="portalProfile"
          defaultValue="CONTACT_COLLABORATOR"
          disabled={pending}
        >
          {PROFILES.map((p) => (
            <option key={p} value={p}>
              {t(`profiles.${p}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Button type="submit" disabled={pending}>
        {pending ? t("adding") : t("add")}
      </Button>
      {/*
        THE SHORTCUT FOR THE COMMON CASE (founder decision, 2026-09-23).
        The row keeps its own Invite verb — every contact that exists
        today was added before there was anything to tick — and this
        saves the second trip for the ones added from now on.

        A Radix `<Checkbox>` rather than `<NativeCheckbox>`: this is a
        plain `<form action>`, not an `<AutoForm>`, so nothing here needs
        a bubbling `change` event, and Radix's hidden bubble input posts
        the value. Inside an AutoForm it would have auto-submitted the
        row on every toggle.

        It sits on its own full-width row under the six fields because
        it is a DECISION about the person rather than a fact about them:
        folding it into the grid beside "Phone" would read as another
        field to fill in.
      */}
      <Label className="col-span-2 flex items-center gap-2.5 font-normal sm:col-span-6">
        <Checkbox name="invite" value="1" disabled={pending} />
        {t("inviteOnAdd")}
      </Label>
      {state && !state.ok ? <FormMessage state={state} className="col-span-2 sm:col-span-6" /> : null}
    </form>
  );
}
