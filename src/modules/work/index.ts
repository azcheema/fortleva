/**
 * Public API of the work module (ARC-16: cross-module imports go
 * through this barrel only; direction time → work → core).
 */
export {
  assignItem,
  changeItemVisibility,
  createItem,
  deleteItem,
  listItems,
  setItemArchived,
  updateItemFields,
  type ItemList,
  type ItemListEntry,
  type WorkCtx,
} from "./items";
export { changeState, ensureProjectStates } from "./states";
