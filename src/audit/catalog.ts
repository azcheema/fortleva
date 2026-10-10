/**
 * The static audit-event catalog (DATA_MODEL.md §3.1, SECURITY.md §7).
 * Write-time visibility is fixed HERE per event type — never decided
 * ad hoc at a call site. Actions are `entity.verb` (dots) — the second
 * of the three deliberately distinct namespaces; permission codes use
 * colons, portal capabilities use `portal.area.verb`.
 */

export type AuditAction = keyof typeof AUDIT_EVENTS;

type EventSpec = {
  readonly visibility: "TENANT" | "PLATFORM";
  /** PLATFORM events also written to the tenant's own log (§3.1). */
  readonly mirroredToTenant?: true;
};

// `as const satisfies` rather than `: EventSpec`, which WIDENS: annotated,
// every lookup types as the full union, so `AUDIT_EVENTS[a].visibility`
// could not be narrowed and a mistake like recording a PLATFORM action
// from tenant context stayed a runtime-only check. Satisfied instead, the
// literal survives and the compiler can carry its weight.
const TENANT = { visibility: "TENANT" } as const satisfies EventSpec;
const PLATFORM = { visibility: "PLATFORM" } as const satisfies EventSpec;
const PLATFORM_MIRRORED = {
  visibility: "PLATFORM",
  mirroredToTenant: true,
} as const satisfies EventSpec;

export const AUDIT_EVENTS = {
  // Auth
  "auth.login_succeeded": TENANT,
  "auth.login_failed": TENANT,
  "auth.mfa_enabled": TENANT,
  "auth.mfa_disabled": TENANT,
  // A WRONG SECOND FACTOR, which until 2026-09-11 was recorded nowhere.
  // It is the highest-signal auth failure there is: at the code prompt
  // the caller has ALREADY PASSED the password, so this is the row that
  // separates "someone is guessing" from "someone is inside". Better
  // Auth also ships a lockout on these endpoints, so an attacker who
  // knows an address can grind codes until that account's second factor
  // locks — denying the account its own sign-in with, until now, no
  // trace anywhere.
  "auth.mfa_verification_failed": TENANT,
  // Replacing the whole recovery set is as consequential as enrolling
  // the factor, and touches only `two_factor.backup_codes` — which the
  // twoFactorEnabled-keyed hooks above cannot see.
  "auth.backup_codes_reissued": TENANT,
  // Slice 84 (C50). The member REPLACED their own authenticator from
  // `/account` — the password plus proof of the current factor (a live
  // code, or an unused backup code when the phone is gone). Its own action
  // because nothing else records it: the user's `twoFactorEnabled` stays
  // true throughout, so `auth.mfa_enabled` never fires. Metadata: the
  // proof's kind (`totp` | `backup_code`) and the sessions ended.
  "auth.factor_replaced": TENANT,
  // The member signed devices out from "Your devices" — one, or every one
  // but this. Metadata: `scope` (`one` | `others`) and the count.
  "auth.sessions_revoked": TENANT,
  "auth.password_changed": TENANT,
  "auth.email_changed": TENANT,
  // Impersonation — both identities, always, visible to the tenant
  "impersonation.started": TENANT,
  "impersonation.ended": TENANT,
  // Membership & authz
  "member.invited": TENANT,
  "member.invite_revoked": TENANT,
  "member.joined": TENANT,
  "member.suspended": TENANT,
  "member.reactivated": TENANT,
  "member.removed": TENANT,
  "member.profile_updated": TENANT, // own-row profile fields (timezone …), metadata: field names only
  "member.role_assigned": TENANT,
  "member.role_removed": TENANT,
  // Slice 84 (C50): an owner reset a teammate's two-factor (the RUNBOOK §8
  // reset, done by the app — `src/auth/member-reset.ts`), or signed them
  // out on every device. Actor = the owner, target = the teammate.
  // Metadata: the sessions ended.
  "member.two_factor_reset": TENANT,
  "member.signed_out_everywhere": TENANT,
  "role.created": TENANT,
  "role.updated": TENANT,
  "role.deleted": TENANT,
  "permission.granted": TENANT,
  "permission.revoked": TENANT,
  "assignment.client_added": TENANT,
  "assignment.client_removed": TENANT,
  "assignment.project_added": TENANT,
  "assignment.project_removed": TENANT,
  "authz.escalation_denied": TENANT,
  // Clients & projects (Phase 2; DATA_MODEL.md §6.4–§6.6)
  "client.created": TENANT,
  "client.updated": TENANT,
  "client.archived": TENANT,
  "client.deleted": TENANT,
  "client.note_updated": TENANT,
  "client.unarchived": TENANT,
  "project.created": TENANT,
  "project.updated": TENANT,
  "project.status_changed": TENANT,
  "project.archived": TENANT,
  "project.key_changed": TENANT,
  "project.portal_enabled": TENANT,
  "project.portal_disabled": TENANT,
  // Slice 74 (C40), actor SYSTEM: written whenever a reconcile pass reads
  // the project's switch OFF and finds rows of that project disagreeing
  // with it — in the pass's own transaction when it CORRECTS them (so the
  // correction and its record commit together), and once more after the
  // last pass if rows are still held disagreeing. It follows the switch
  // the pass READ, which need not be the press that ran it. The gate
  // exists to make that impossible, so the row is the durable trace of a
  // possible exposure, not a routine event. Metadata is ids and counts
  // only (`src/projects/portal-gate.ts`).
  "project.portal_stamp_alarm": TENANT,
  "project.hours_sharing_changed": TENANT,
  // Phase 3 slice 80 (C47): a section of the project shown or hidden on
  // the client's portal. Metadata `{ section, shown }` — layout, not a
  // gate, but it changes what a client is shown, so it is recorded.
  "project.portal_section_changed": TENANT,
  "project.viewed_as_contact": TENANT,
  "project_version.created": TENANT,
  "project_version.updated": TENANT,
  "project_version.shipped": TENANT,
  "project_version.approval_requested": TENANT,
  "project_version.approved": TENANT,
  "project_version.changes_requested": TENANT,
  "milestone.created": TENANT,
  "milestone.updated": TENANT,
  "milestone.completed": TENANT,
  "service.created": TENANT,
  "service.updated": TENANT,
  "service.ended": TENANT,
  "service.deleted": TENANT,
  // Contacts & portal (contact.created is a Phase-2 record emitter; the
  // rest are Phase 3 emitters — catalog is static)
  "contact.created": TENANT,
  "contact.updated": TENANT,
  "contact.deleted": TENANT,
  "contact.invited": TENANT,
  "contact.activated": TENANT,
  "contact.suspended": TENANT,
  // The pause's other half (Phase 3, the invite slice). The founder
  // chose TWO ways to take access away — a pause that resumes in one
  // click and a removal that ends it — so the resume needs its own row:
  // an operator reading the log must be able to see that access came
  // BACK, and re-deriving it from the absence of a later event is not
  // reading a log, it is guessing from one.
  "contact.access_restored": TENANT,
  "contact.access_revoked": TENANT,
  // The person's own weekly summary stopped or started again (Phase 5 slice
  // 101, C69) — from the link in their mail, never by anyone at the agency.
  // Actor SYSTEM, target the Contact; metadata says only which door
  // (`one_click` from the mail's header, `page` from the link's page).
  "contact.summary_stopped": TENANT,
  "contact.summary_started": TENANT,
  // Files & visibility
  "document.created": TENANT,
  "document.renamed": TENANT,
  "file.uploaded": TENANT,
  "file.downloaded": TENANT,
  "document.visibility_changed": TENANT,
  "document.deleted": TENANT,
  // Deliverable sign-off (Phase 3, DATA_MODEL §6.8): staff ask, the
  // client answers. ONE decided verb with the outcome in metadata,
  // where `project_version` has two — both shapes are the documents'
  // own (§6.5 names `approved | changes_requested`, §6.8 names
  // `approval_decided`), and a catalog action is immutable once
  // emitted, so neither family is renamed to match the other.
  "document.approval_requested": TENANT,
  "document.approval_decided": TENANT,
  // A new version uploaded while an ask was open: the ask is voided (the
  // client must not approve bytes they never saw), and the vanishing is
  // a change a person can see, so it is a row.
  "document.approval_voided": TENANT,
  // Money (Phase 4 emitters)
  "contract.sent": TENANT,
  "contract.signed": TENANT,
  "contract.declined": TENANT,
  // Phase 4 slice 112 — contracts (C84): the templates owners and admins keep,
  // and a contract's draft life. Ids and which fields — never the text.
  "contract_template.created": TENANT,
  "contract_template.updated": TENANT,
  "contract_template.deleted": TENANT,
  "contract.created": TENANT,
  "contract.draft_edited": TENANT,
  "contract.draft_deleted": TENANT,
  "invoice.issued": TENANT,
  "invoice.sent": TENANT,
  "invoice.paid": TENANT,
  "invoice.credited": TENANT,
  "series.created": TENANT,
  // Phase 4 slice 107 — DRAFTS (src/modules/invoicing/drafts.ts). A draft
  // has no number and nobody outside the team sees it, but it is money, and
  // there is no carve-out for it: its creation, every edit (metadata: the
  // fields or the line operation, never an org. number) and its deletion
  // are rows.
  "invoice.created": TENANT,
  "invoice.draft_edited": TENANT,
  "invoice.draft_deleted": TENANT,
  // Phase 4 slice 108 — issuing (src/modules/invoicing/issue.ts, series.ts,
  // pdf-store.ts). `invoice.issued` (above) carries the number, the series and
  // the totals; `invoice.pdf_generated` the archived file (its id, hash, size
  // and the template's version — the record of which drawing it is);
  // `series.created` (above) the first number; `series.first_number_changed`
  // its change before anything was numbered (from, to).
  "invoice.pdf_generated": TENANT,
  "series.first_number_changed": TENANT,
  // Phase 4 slice 110 — hours onto invoices (src/modules/invoicing/hours.ts;
  // C80). `invoice.hours_added`: lines made from tracked hours on a draft
  // (metadata: how — created / added / corrected_copy —, the grouping, the
  // line ids, how many hours and how many were left out, each project's
  // rounding rule; the hours themselves are the line's record,
  // `invoice_line_time_entry`). `invoice.hours_returned`: hours of a partly
  // credited invoice put back on the ready list by hand (their ids). A credit
  // in full that frees them says so on `invoice.credited` (`hoursFreed`).
  "invoice.hours_added": TENANT,
  "invoice.hours_returned": TENANT,
  // …and the two marks (C80 (g)) — "Billed elsewhere", "Won't invoice", and
  // their undoing: the hours' ids are in the row, their only history.
  "time_entry.marked_billed_elsewhere": TENANT,
  "time_entry.marked_written_off": TENANT,
  "time_entry.billing_mark_cleared": TENANT,
  // Phase 4 slice 109 — sending and payments (src/modules/invoicing/send.ts;
  // C79). `invoice.sent` (above) names the send's record and how it went,
  // never an address (they are on `invoice_delivery`); `invoice.paid` the day
  // and whether there is a note, never the note; `invoice.payment_undone` what
  // was undone (C79 (h)). `invoice.pdf_downloaded` — a CLIENT's download from
  // the portal, brokered and audited to the contact (`portal-writes.ts`).
  "invoice.payment_undone": TENANT,
  "invoice.pdf_downloaded": TENANT,
  // …and `invoice.send_attempted` — a send's RESERVATION, written and
  // committed before any mail goes (the security review's medium): the
  // sending budget counts these (an address count and a digest of the list,
  // never an address), and an attempt whose record later failed still leaves
  // this trace.
  "invoice.send_attempted": TENANT,
  // …voided when the send reached nobody (the code review's medium): no
  // double click, no budget spent.
  "invoice.send_attempt_voided": TENANT,
  // Settings → Invoicing (src/modules/invoicing/seller.ts). Both protected
  // cards — the code typed in the form, every owner mailed (C75 (h)–(j)) —
  // and the settings page reads each one's newest row to say who changed it
  // and when. Company: the FIELD NAMES only, never the values — an org.
  // number can be a sole trader's personnummer. Payment: the field names,
  // each bank field's LAST FOUR characters (the trail says where money
  // pointed, a reader cannot lift the account) and the note's new text (the
  // workspace's own words, printed on every invoice).
  "invoice_settings.company_changed": TENANT,
  "invoice_settings.payment_details_changed": TENANT,
  // Phase 4 slice 111 — the bookkeeping file (src/modules/invoicing/
  // bookkeeping.ts; C82). `invoice_settings.bookkeeping_changed`: the method,
  // the year's first month, the series or an account — each changed field's
  // old and new value (nothing secret: account numbers). `invoice_export.
  // created`: a file made — its number, method, how many of each event, the
  // first and last day. `invoice_export.downloaded`: a file handed over — which
  // one, which format, and the bytes' SHA-256 (what exactly left).
  "invoice_settings.bookkeeping_changed": TENANT,
  "invoice_export.created": TENANT,
  "invoice_export.downloaded": TENANT,
  // Phase 4 slice 111b — the cash method's year end (bookkeeping.ts; C83).
  // `invoice_export.year_end_booked`: the year-end file made — its number,
  // the year's last day, how many unpaid invoices it books and their total in
  // kronor (the corrections that follow ride in later files'
  // `invoice_export.created` counts).
  "invoice_export.year_end_booked": TENANT,
  // Data egress
  "export.requested": TENANT,
  "export.generated": TENANT,
  "export.downloaded": TENANT,
  // Preferences
  "preference.changed": TENANT,
  // Crypto — per-tenant envelope keys (metadata: key ids only)
  "tenant_key.created": TENANT,
  "tenant_key.rotated": TENANT,
  // Continuity box (Phase 8 emitters)
  "continuity_box.sealed": TENANT,
  "continuity_box.resealed": TENANT,
  "continuity_box.beneficiary_changed": TENANT,
  "continuity_box.trustee_changed": TENANT,
  "continuity_box.open_requested": TENANT,
  "continuity_box.request_withdrawn": TENANT,
  "continuity_box.vetoed": TENANT,
  "continuity_box.escalated": TENANT,
  "continuity_box.opened": TENANT,
  "continuity_box.download_issued": TENANT,
  "continuity_box.closed": TENANT,
  // Work (Phase 2W — privileged transitions only; routine field edits
  // live in WorkItemActivity, never here)
  "work_item.created": TENANT,
  "work_item.deleted": TENANT,
  "work_item.state_changed": TENANT,
  "work_item.visibility_changed": TENANT,
  "work_item.triaged": TENANT,
  "work_item.archived": TENANT,
  "work_item.bulk_edited": TENANT,
  "comment.deleted": TENANT,
  "comment.visibility_changed": TENANT,
  // Editing SOMEONE ELSE's comment (`comment:edit_any`) — founder
  // decision 2026-09-12: one's own comments are routine (a history row,
  // no audit), another member's words are not.
  "comment.edited_by_other": TENANT,
  // THE PORTAL FAMILY — contact-CAUSED writes, brokered under the
  // system principal after `authorizePortal()` (AUTHZ.md §8). They are
  // `portal.*` rather than `work_item.*` because the family names WHO
  // caused the row, not which table it landed in: a member creating a
  // task is `work_item.created`, and a client submitting a request is
  // not the same event with a different actor — it is the one act a
  // client can perform on the agency's board, and an operator reading
  // the log filters for exactly it.
  //
  // The actor is the CONTACT even though the transaction is a system
  // one: `record()` takes `brokeredForContactId` for precisely this,
  // and refuses it outside a system transaction.
  "portal.request_created": TENANT,
  // The client's "I've done my part" on a task the agency assigned to
  // them, and its retraction (Phase 3 slice 6c). AUDITED RATHER THAN
  // ROUTINE even though nothing moves: the founder's 2026-09-12 rule
  // makes a field edit routine when a MEMBER makes it, and every event
  // in this family is the other thing — the short list of acts a client
  // can perform on the agency's board, which is exactly what an
  // operator filters for. The withdrawal is its own action and not a
  // `{done:false}` on the first, because "the client took it back" is a
  // different question from "when did they say so" and a metadata flag
  // is not something anybody greps.
  "portal.task_completed": TENANT,
  "portal.task_completion_withdrawn": TENANT,
  // A CLIENT's comment on a shared task (Phase 3 slice 75). NOT brokered,
  // unlike the three above: a comment is the contact-writable census's
  // one INSERT, written under the contact's OWN principal
  // (`withCensusWrite`), so `record()` derives actor CONTACT from the
  // transaction and `portal_audit_insert` admits exactly that row. A
  // MEMBER's own comment is routine (a history row, no audit — the
  // 2026-09-12 carve-out); a client's is in this family because it is on
  // the short list of acts a client can perform on the agency's board.
  "portal.comment_created": TENANT,
  "workflow.changed": TENANT,
  "label.created": TENANT,
  "label.deleted": TENANT,
  "project_template.applied": TENANT,
  "notification.preference_changed": TENANT,
  // Phase 5 slice 106 (founder decision C74) — a member turned phone
  // notifications on for a device, or removed one (`src/push/devices.ts`).
  // Metadata: the device's id and label ("Chrome · Android"), never its
  // endpoint or keys. Re-linking a device the same person turned on to their
  // next sign-in writes NONE (C74 (k), AGENTS.md): the sign-in is audited, and
  // the device's choices did not change. Nor do the drain's own deletes (a
  // device its push service says is gone, three refusals, 90 days dormant, a
  // member no longer active) — the inbox's housekeeping precedent.
  "push_device.added": TENANT,
  "push_device.removed": TENANT,
  // Phase 5 slice 100 (founder decision C68 (c), (f)) — where replies to the
  // workspace's mail go (`src/notify/reply-address.ts`). `requested`,
  // `request_cancelled` and `removed` are a member's (`settings:edit`);
  // `confirmed` is a SYSTEM row — whoever pressed Confirm on the mailed link
  // holds a mailbox, not a seat — naming the member who asked in its
  // metadata. Each carries the ADDRESS: it is the workspace's own setting,
  // and an owner asking later where clients' replies went needs the trail to
  // say. A cancellation because the confirmation mail could not be sent says
  // so (`reason: "mail_failed"`).
  "reply_address.requested": TENANT,
  "reply_address.request_cancelled": TENANT,
  "reply_address.confirmed": TENANT,
  "reply_address.removed": TENANT,
  "search.index_rebuilt": TENANT,
  // Time (Phase 2T — DATA_MODEL.md §6.15; metadata NEVER carries a cost
  // amount, SECURITY.md §9.7.4)
  "timer.started": TENANT,
  "timer.stopped": TENANT,
  "timer.auto_stopped": TENANT,
  "time_entry.created": TENANT, // manual / duration entries
  "time_entry.updated": TENANT, // own edit of an editable timestamp — founder: "editable, audited"
  "time_entry.edited_by_other": TENANT,
  "time_entry.deleted": TENANT,
  "time_entry.locked": TENANT,
  "time_entry.unlocked": TENANT,
  "time_entry.repriced": TENANT,
  "time.exported": TENANT,
  "rate_card.created": TENANT,
  "rate_card.closed": TENANT,
  "rate_card.cost_revealed": TENANT, // aggregate, once per session
  // Phase 3V slice 1 — the vault (DATA_MODEL.md §6.17, SECURITY.md §6.3).
  // Metadata is the credential's ids, the field NAMES and counts — never
  // a value, never a seed. Reveal, Copy and a TOTP code are one row each,
  // per call, written in the transaction that decrypted.
  "credential.created": TENANT,
  "credential.updated": TENANT, // metadata edits AND a replaced secret (`secretChanged`); `heldBySeed` when every field was made new but a seed a leaver exported kept "Change soon" (C63 (e), slice 95)
  "credential.deleted": TENANT,
  "credential.revealed": TENANT,
  "credential.copied": TENANT,
  "credential.totp_generated": TENANT,
  // The two refusals the vault records (AUTHZ.md §7.5: a step-up challenge
  // is never `authz.escalation_denied`). Both commit although the act is
  // refused — a refusal that left no row would be invisible exactly when
  // somebody is probing.
  "vault.step_up_required": TENANT,
  "vault.reveal_budget_exceeded": TENANT,
  // Phase 3V slice 90 — share links. Target: the LINK (CredentialShareLink),
  // so one link's whole life reads as one thread; metadata names the
  // credential and the field — never the token, the code, the address or a
  // value. `shared` and `share_revoked` are a member's acts (a revoke caused
  // by a seal carries `cause: "sealed"`, by a member's removal `cause:
  // "member_removed"` with the departed `memberId` — C62 (a)); the other three
  // are the share page's, written by the SYSTEM principal with the visitor's
  // ip and user agent from the request: a code mailed, a wrong code (with
  // the attempt's number), and the one view.
  "credential.shared": TENANT,
  "credential.share_revoked": TENANT,
  "credential.share_code_sent": TENANT,
  "credential.share_code_refused": TENANT,
  "credential.share_viewed": TENANT,
  // Phase 3V slice 91 — logins shown to a client (founder decisions C52
  // (d)/(k), C59). A member's mark or un-mark (`credential:change_
  // visibility`); metadata the new `visibility`, and `cause: "switch_off"`
  // on the rows written when switching client logins OFF un-marked every
  // login (C59 (b)) — one row per login, so each login's thread says why.
  "credential.visibility_changed": TENANT,
  // Phase 3V slice 92 — the sealed layer's staff side (founder decisions
  // C52 (e), C60). A member seals a login for its client
  // (`credential:edit`; metadata the client and `wasShown` — a shown login
  // is hidden by the seal, which also writes a `credential.visibility_
  // changed` with `cause: "sealed"`, and every open share link is revoked,
  // one `credential.share_revoked` each with `cause: "sealed"`); an owner
  // unseals one (`credential:unseal`). Deleting a sealed login is
  // `credential.deleted` with `sealed: true`.
  "credential.sealed": TENANT,
  "credential.unsealed": TENANT,
  // THE CLIENT'S DOOR to those logins (C52 (k): their portal password AND
  // a code mailed each time), in the portal family because a CONTACT
  // caused each row: brokered under the system principal, actor the
  // contact (`brokeredForContactId`), target the door (ContactVaultUnlock)
  // once there is one and the contact before. `unlock_started` is written
  // BEFORE the password is checked — it is what the per-contact budget
  // counts, so concurrent guesses cannot all slip under it — and
  // `password_refused` after a wrong one; then a code mailed (first or
  // again), a wrong code (with the attempt's number), and the opening.
  // What the contact then looks at is `credential.revealed | copied` with
  // the CONTACT as actor — the same two actions a member's look writes.
  "portal.logins_unlock_started": TENANT,
  "portal.logins_password_refused": TENANT,
  "portal.logins_code_sent": TENANT,
  "portal.logins_code_refused": TENANT,
  "portal.logins_opened": TENANT,
  // Phase 3V slice 99 — THE DOOR'S ALARM (founder decision C67 (b)–(e)):
  // someone typed a wrong mailed code five times in a day (over any number
  // of openings), or the portal password wrong five times in a day (at the
  // door or in front of a sealed ask), so the owners and the contact are
  // told. Written by the SYSTEM principal — the contact did not raise it —
  // target the CONTACT; metadata the client, the `alarmId` both mails are
  // keyed by, and the signs it newly reports (`passwords`, `codes`). At most
  // one per SIGN per contact per 24 hours: these rows are what that rule
  // counts.
  "portal.logins_alarm_raised": TENANT,
  // Phase 3V slice 93 — A CLIENT ASKS TO OPEN THEIR SEALED LOGINS (founder
  // decisions C52 (f)–(j), C61). Target: the ask (SealedOpenRequest), so one
  // ask's whole life reads as one thread; metadata names the client — never
  // the reason's or a denial's words, which live on the row and nowhere else.
  // The client's acts are brokered under the system principal with the
  // CONTACT as actor (`brokeredForContactId`): the ask (`open_requested`,
  // the wait it was frozen with), a withdrawal, the confirmation after the
  // silent wait (it opens 48 hours later). The password check in front of
  // an ask is counted as the door's is — `portal.logins_unlock_started`
  // before it and `portal.logins_password_refused` after a wrong one, with
  // `purpose: "ask"` — so asking and opening share one per-contact budget.
  // An answer is a MEMBER's own (`credential:unseal`): approved — it opens
  // at once — or denied. The daily job writes `open_request_reminded` as
  // SYSTEM for each mail it sends the answerers (a reminder, or "it has
  // opened"), with how many it reached. What the contact then looks at is
  // `credential.revealed | copied` with the CONTACT as actor and
  // `sealed: true`. An ask refused AFTER a right password — nothing sealed,
  // one already in play, the cool-down, the day's three — is
  // `open_request_refused` with that reason code (target the contact), so
  // the trail never shows a password check that went nowhere.
  "credential.open_requested": TENANT,
  "credential.open_request_refused": TENANT,
  "credential.open_request_withdrawn": TENANT,
  "credential.open_request_confirmed": TENANT,
  "credential.open_request_approved": TENANT,
  "credential.open_request_denied": TENANT,
  "credential.open_request_reminded": TENANT,
  // Phase 3V slice 94 — offboarding flags (plan §3.4, SECURITY.md §6.3).
  // Suspending a member marks every login they could know the secret of
  // — revealed, copied, shared or typed in the last 90 days — "Change
  // soon": one row per login, newly flagged only, written in the
  // suspension's transaction with the remover as actor; metadata the
  // departed `memberId` and `cause: "member_removed"`.
  "credential.rotation_flagged": TENANT,
  // Phase 3V slice 99 — the vault's retention (DATA_MODEL §5 R2; founder
  // decision C67 (a), (f)). The daily job, as SYSTEM, erases a login 30 days
  // after it was binned — its secret and versions, always: one row per
  // login, target the login; metadata its client and project, and, when
  // its row is KEPT bare, why: `kept: "sent"` (a client sent it — the
  // client's record of it stays for good, named as they sent it) or
  // `kept: "links"` (one of its share links' records is within its 12
  // months — the row stays, under its own name, until none is). Not
  // audited: such a row's later release, and a share link's record
  // leaving 12 months after it expired — the audit rows of their lives are
  // the evidence, and outlive them.
  "credential.purged": TENANT,
  // Phase 3V slice 95 — the plaintext export (`credential:export` ✦,
  // founder decision C63). ONE row PER LOGIN in the file, target the login,
  // so a login's trail and the offboarding flags (slice 94) read an export
  // as they read a reveal; metadata the `exportId` grouping one export and
  // what was asked for (`scope`: all | client | agency, the `clientId` for
  // one client), and `seed: true` when the login's authenticator seed was
  // in the file (C63 (e)) — never a value.
  "credential.exported": TENANT,
  // Phase 3V slice 96 — portal submission (founder decision C64): a
  // client's contact handed a login over through the portal, brokered —
  // written by the SYSTEM principal with the CONTACT as actor
  // (`brokeredForContactId`), target the new login; metadata its client,
  // project, type and the secret field NAMES — never a value, never its
  // name. Also the contact's own hand-over budget (a count of these rows).
  // Slice 98: a hand-over that answers an ask carries its `askId` too — the
  // send IS this row; the ask's own row records only that it was sent.
  "credential.submitted": TENANT,
  // Phase 3V slice 98 — the agency asks a client for a named login (founder
  // decision C66). Target the ASK (`CredentialAsk`); metadata its client,
  // project, the contact asked and the type — never what the team wrote
  // (its name and note; an audit row outlives the ask and is read by
  // operators). `asked` and `ask_cancelled` are the member's;
  // `ask_declined` is the asked contact's, brokered — written by the SYSTEM
  // principal with the CONTACT as actor (`brokeredForContactId`), and never
  // carries the client's note either.
  "credential.asked": TENANT,
  "credential.ask_cancelled": TENANT,
  "credential.ask_declined": TENANT,
  // Phase 3V slice 87 — the asset registry. Metadata is the asset's
  // client, project and type, and on an edit the NAMES of the fields that
  // changed — never a value (a note is free text).
  "asset.created": TENANT,
  "asset.updated": TENANT,
  "asset.deleted": TENANT,
  // Phase 3V slice 89 — one row per renewal reminder the daily job sent,
  // written by the SYSTEM principal in the same transaction as the
  // reminder and its dedupe row. Target: the asset or agreement, or for
  // logins (a count per client, C56) the client — or the tenant for our own
  // logins. Metadata: the band, the day, how many received it, and for
  // logins how many — never a login's id or name.
  "expiration.reminder_sent": TENANT,
  "budget.created": TENANT,
  "budget.changed": TENANT,
  "budget.alert_sent": TENANT,
  "staff_notice.published": TENANT,
  "staff_notice.acknowledged": TENANT,
  // D1 shifts
  "shift.started": TENANT,
  "shift.stopped": TENANT,
  "shift.auto_stopped": TENANT,
  "shift.updated": TENANT, // own correction (e.g. confirming a provisional auto-stop)
  "shift.edited_by_other": TENANT,
  "shift.deleted": TENANT,
  "shift.break_started": TENANT,
  "shift.break_stopped": TENANT,
  // D3 published time reports
  "time_report.created": TENANT,
  "time_report.updated": TENANT,
  "time_report.published": TENANT,
  "time_report.unpublished": TENANT,
  "time_report.archived": TENANT,
  "time_report.deleted": TENANT,
  // PROGRESS UPDATES (Phase 3 — DATA_MODEL.md §6.16; ride on `work`).
  // Publishing puts member-written prose in front of a client and
  // freezes the numbers beside it; every later change to what the
  // client can read is here too. A DRAFT edit is routine (nobody but
  // staff can see a draft) and writes nothing.
  // A draft is listed to every member with `project_update:view`, so
  // who started one is recorded once; its edits are routine (a "Save
  // draft" per row would be noise, and nobody outside staff reads a draft).
  "project_update.drafted": TENANT,
  "project_update.published": TENANT,
  "project_update.archived": TENANT,
  "project_update.visibility_changed": TENANT,
  // Back to DRAFT within the fifteen-minute window — the number and the
  // snapshots are given up, so an operator must be able to see that a
  // client MAY have read a post that no longer exists.
  "project_update.retracted": TENANT,
  // The one text that changes after publish: a note under an immutable
  // post ("Correction: read October for September"), client-readable.
  "project_update.annotated": TENANT,
  // A draft nobody outside staff could see, deleted — recorded because
  // deletion is never routine, and because a draft can hold an hour's
  // writing.
  "project_update.draft_discarded": TENANT,
  // Phase 5 slice 102 (C70): the hourly job reminded a project's lead (or
  // its people) that its progress update is due today or late — one row
  // per reminder, written as SYSTEM in the transaction with its dedupe row
  // and its inbox rows. Target: the project. Metadata: the due day, the
  // step (0 the due day, 1 and 2 the working days after) and how many
  // received it — never a name.
  "project_update.reminder_sent": TENANT,
  // Phase 5 slice 105 (C73 (c), (d), (g)): the workspace's progress-update
  // LAYOUTS, edited under `settings:edit`. Target: the layout. Metadata:
  // field names on an edit; on a delete, how many projects went back to the
  // default; on a default change, the layout ids before and after (null =
  // Fortleva standard). Never a heading's text.
  "project_update_template.created": TENANT,
  "project_update_template.updated": TENANT,
  "project_update_template.deleted": TENANT,
  "project_update_template.default_changed": TENANT,
  // D5 work types
  "work_type.created": TENANT,
  "work_type.updated": TENANT,
  "work_type.archived": TENANT,
  // System jobs: ONE summary event per run (TENANCY §12 amendment)
  "job.run": PLATFORM,
  // Platform plane
  "tenant.provisioned": PLATFORM,
  "tenant.suspended": PLATFORM,
  "tenant.offboarded": PLATFORM,
  "entitlements.changed": PLATFORM_MIRRORED,
  "plan.changed": PLATFORM_MIRRORED,
  "flag.changed": PLATFORM,
  // PLATFORM-PLANE AUTH (2026-09-11). The console instance recorded
  // NOTHING until now — no auditPlugin, and databaseHooks carrying only
  // the session stamp — so sign-ins, failures and second-factor changes
  // on the plane that reaches `app_platform` (BYPASSRLS, cross-tenant)
  // left no trace at all.
  //
  // They are `platform.*` rather than `auth.*` because they are a
  // different KIND of row, not the same row with a null tenant: the
  // actor id lives in the global `user` namespace rather than a tenant's
  // `member` namespace, there is no tenant to file them under, and the
  // audience is the platform operator and never a tenant. Writing them
  // as `auth.*` would also route them through recordForUserMemberships,
  // which fans out per ACTIVE MEMBERSHIP — and a platform admin with no
  // tenant membership has none, so the fan-out writes zero rows and
  // reports success. That silence is the bug being fixed.
  "platform.login_succeeded": PLATFORM,
  "platform.login_failed": PLATFORM,
  "platform.mfa_verification_failed": PLATFORM,
  "platform.mfa_enabled": PLATFORM,
  "platform.mfa_disabled": PLATFORM,
  "platform.password_changed": PLATFORM,
  "platform.email_changed": PLATFORM,
  // Slice 84 (its code review): an account-level change made from the
  // MEMBER plane's `/account` — the authenticator replaced, the backup
  // codes reissued, devices signed out — written here as well when the
  // account is a console principal (one factor row serves both planes) or
  // no ACTIVE membership took the `auth.*` row, the silence described
  // above. `src/auth/audit-hooks.ts`, `recordAccountEvent`.
  "platform.factor_replaced": PLATFORM,
  "platform.backup_codes_reissued": PLATFORM,
  "platform.sessions_revoked": PLATFORM,
  "platform.tenant_access": PLATFORM_MIRRORED,
  "platform.system_job": PLATFORM,
  // Test-only event (used by the isolation and audit suites)
  "test.event": TENANT,
} as const satisfies Record<string, EventSpec>;

export const isAuditAction = (action: string): action is AuditAction =>
  action in AUDIT_EVENTS;
