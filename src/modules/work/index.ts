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
  resolveStateNames,
  resolveStates,
  setItemArchived,
  updateItemFields,
  type AssignmentCommitted,
  type ItemDetail,
  type ItemDetailResult,
  type ItemFieldsCommitted,
  type ItemList,
  type ItemListEntry,
  type ResolvedItemDetail,
  type ResolvedItemDetailResult,
  type ResolvedItemList,
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
export { moveItem, rebalanceProjectRanks, type MoveInput, type MovedItem } from "./ordering";
export { changeState, ensureProjectStates, type StateChange } from "./states";
export { updateItemDescription, type DescriptionSaved } from "./description";
export { ACTIVITY_PAGE_SIZE, type ActivityActor, type ActivityEntry, type ItemActivityPage } from "./activity";
export { descriptionToken } from "./description-token";
