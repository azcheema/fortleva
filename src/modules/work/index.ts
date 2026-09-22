/**
 * Public API of the work module (ARC-16: cross-module imports go
 * through this barrel only; direction time → work → core).
 */
export {
  assignItem,
  changeItemVisibility,
  createItem,
  deleteItem,
  getItemDetail,
  listItems,
  projectWorkVersion,
  resolveItemDetail,
  resolveRowState,
  resolveStateNames,
  resolveStates,
  setItemArchived,
  setItemMilestone,
  updateItemFields,
  type AssignmentCommitted,
  type ItemDetail,
  type ItemDetailCaps,
  type ItemDetailResult,
  type ItemFieldsCommitted,
  type ItemList,
  type ItemListEntry,
  type MilestoneAssigned,
  type MilestoneEntry,
  type MilestoneStatus,
  type ResolvedItemDetail,
  type ResolvedItemDetailResult,
  type ResolvedItemList,
  type ResolvedItemSubtasks,
  type ResolvedSubtaskEntry,
  type ResolvedWorkflowState,
  type VisibilityCommitted,
  type WorkCtx,
  type WorkflowStateEntry,
} from "./items";
export {
  bulkChangeState,
  bulkSetArchived,
  bulkSetPriority,
  type BulkResult,
} from "./bulk";
export { listMyWork } from "./my-work";
export { moveItem, rebalanceProjectRanks, type MoveInput, type MovedItem } from "./ordering";
export { changeState, ensureProjectStates, type StateChange, type TriageWrite } from "./states";
// Phase 3 slice 6b — the triage lane (`work_item:triage`). The member
// side of the portal's request intake: Accept / Decline / Duplicate /
// Snooze, with the client-readable reason a decline must carry.
export { triageItem, type TriageInput, type TriageOutcome } from "./triage";
// The lane's READ is a MEMBER-plane projection and lives apart from the
// verbs, because `triage.ts` is inside the portal tripwire's structural
// tier and this read legitimately names columns that tier forbids. See
// `triage-lane.ts`'s header — the split is the tripwire's doing, and it
// is the right shape rather than a workaround.
export {
  TRIAGE_LANE_LIMIT,
  listTriage,
  type TriageEntry,
  type TriageLane,
} from "./triage-lane";
// The verb list and the two caps come from the LEAF, never from
// `./triage`: the lane's `"use client"` dialog needs them and
// `./triage` reaches `@/db`. Same arrangement, same reason, as
// `request-limits.ts` — see that file's header and this one's.
export {
  TRIAGE_REASON_MAX,
  TRIAGE_SNOOZE_MAX_DAYS,
  TRIAGE_VERBS,
  type TriageVerb,
} from "./triage-limits";
export { updateItemDescription, type DescriptionSaved } from "./description";
export { ACTIVITY_PAGE_SIZE, type ActivityActor, type ActivityEntry, type ItemActivityPage } from "./activity";
// Types only — `readItemSubtasks` stays off the barrel for the reason `readItemActivity` does (subtasks.ts).
export { type ItemSubtasks, type SubtaskEntry } from "./subtasks";
// The writers; `readItemComments` stays off the barrel for the same reason (comments.ts).
export {
  COMMENT_LIST_LIMIT,
  createComment,
  deleteComment,
  setCommentVisibility,
  updateComment,
  type CommentAuthor,
  type CommentCreated,
  type CommentEdited,
  type CommentEntry,
  type CommentVisibilityCommitted,
  type ItemComments,
} from "./comments";
export { descriptionToken } from "./description-token";
// The writers; `readItemLabels` stays off the barrel for the same reason (labels.ts).
export {
  createLabel,
  setItemLabel,
  type ItemLabels,
  type LabelCreated,
  type LabelEntry,
  type LabelVerb,
  type LabelsCommitted,
} from "./labels";
// Phase 3 — the portal projections (reads only; the brokered writes are
// below). Exported from the barrel because the portal PAGES are the
// callers and ARC-16 routes every cross-boundary import through here.
export {
  PORTAL_TASK_CATEGORIES,
  PORTAL_TASK_LIMIT,
  listPortalTasks,
  type PortalProjectTasks,
  type PortalTask,
  type PortalTaskCategory,
  type PortalTaskList,
  type PortalTaskListOptions,
} from "./portal";
// Phase 3 — the brokered writes (`portal-writes.ts`: authorize under
// the contact's own principal, write under a system one). The row
// shaping they delegate to (`requests.ts`) is deliberately NOT on the
// barrel: `createRequest` forces the columns a submitter may not choose
// and takes a caller-supplied transaction, so the only safe caller is
// the broker next door.
export {
  createPortalRequest,
  type PortalRequestCreated,
  type PortalRequestInput,
} from "./portal-writes";
// The two length caps are NOT re-exported here, and that is deliberate:
// the portal's request form is a client component, and anything it
// imports from this barrel drags `portal-writes.ts` → `withTenant` →
// `pg` into the browser graph (measured — the build failed on
// `util/types`). It imports `@/modules/work/request-limits` directly,
// the leaf, exactly as `src/config/view-as.ts` is imported in slice 48.
