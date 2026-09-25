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
  "project.hours_sharing_changed": TENANT,
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
  // Files & visibility
  "document.created": TENANT,
  "document.renamed": TENANT,
  "file.uploaded": TENANT,
  "file.downloaded": TENANT,
  "document.visibility_changed": TENANT,
  "document.deleted": TENANT,
  // Money (Phase 4 emitters)
  "contract.sent": TENANT,
  "contract.signed": TENANT,
  "contract.declined": TENANT,
  "invoice.issued": TENANT,
  "invoice.sent": TENANT,
  "invoice.paid": TENANT,
  "invoice.credited": TENANT,
  "series.created": TENANT,
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
  "workflow.changed": TENANT,
  "label.created": TENANT,
  "label.deleted": TENANT,
  "project_template.applied": TENANT,
  "notification.preference_changed": TENANT,
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
  "platform.tenant_access": PLATFORM_MIRRORED,
  "platform.system_job": PLATFORM,
  // Test-only event (used by the isolation and audit suites)
  "test.event": TENANT,
} as const satisfies Record<string, EventSpec>;

export const isAuditAction = (action: string): action is AuditAction =>
  action in AUDIT_EVENTS;
