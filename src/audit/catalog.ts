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

const TENANT: EventSpec = { visibility: "TENANT" };
const PLATFORM: EventSpec = { visibility: "PLATFORM" };
const PLATFORM_MIRRORED: EventSpec = { visibility: "PLATFORM", mirroredToTenant: true };

export const AUDIT_EVENTS = {
  // Auth
  "auth.login_succeeded": TENANT,
  "auth.login_failed": TENANT,
  "auth.mfa_enabled": TENANT,
  "auth.mfa_disabled": TENANT,
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
  "platform.tenant_access": PLATFORM_MIRRORED,
  "platform.system_job": PLATFORM,
  // Test-only event (used by the isolation and audit suites)
  "test.event": TENANT,
} as const satisfies Record<string, EventSpec>;

export const isAuditAction = (action: string): action is AuditAction =>
  action in AUDIT_EVENTS;
