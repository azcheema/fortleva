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
export { changeState, ensureProjectStates, type StateChange } from "./states";
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
// Phase 3 — the portal projections (reads only; brokered writes will
// live in `portal-writes.ts`). Exported from the barrel because the
// portal PAGES are the callers and ARC-16 routes every cross-boundary
// import through here.
export {
  PORTAL_TASK_CATEGORIES,
  PORTAL_TASK_LIMIT,
  listPortalTasks,
  type PortalProjectTasks,
  type PortalTask,
  type PortalTaskCategory,
  type PortalTaskList,
} from "./portal";
