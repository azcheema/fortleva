/**
 * Row-action menu construction (UI.md §5.9, §9).
 *
 * A destructive action repeated on every row of every table is the
 * loudest thing a table can carry, so the weight moves into the menu:
 * `tone: "danger"` becomes danger TEXT on a menu item, never a filled
 * button in the row, and the type below makes the confirmation
 * question mandatory — a delete with no question cannot be expressed.
 *
 * The logic lives here rather than in the component so the parts that
 * can silently go wrong (a duplicate key collapsing two actions into
 * one, a danger item with no question, a disabled item with no reason)
 * are checked without a DOM.
 */

export type RowActionTone = "default" | "danger";

export type RowActionHidden = { name: string; value: string };

type RowActionBase = {
  key: string;
  /** From t(). Also the confirm's subject, so it names the row. */
  label: string;
  disabled?: boolean;
  /** Why it is disabled — rendered as the item's inert explanation. */
  disabledReason?: string;
  onSelect?: () => void;
  /** A server action, called in a transition with `hidden` as its FormData. */
  formAction?: (formData: FormData) => void | Promise<void>;
  hidden?: readonly RowActionHidden[];
};

/**
 * `tone: "danger"` REQUIRES `confirm`. This is the type-level half of
 * "no destructive action without a question"; `rowActionIssues()` is
 * the runtime half for data-built menus.
 */
export type RowActionSpec =
  | (RowActionBase & { tone?: "default"; confirm?: string })
  | (RowActionBase & { tone: "danger"; confirm: string });

/** Menu items are `variant="destructive"` — danger text, tinted hover. */
export const rowActionVariant = (item: {
  tone?: RowActionTone;
}): "default" | "destructive" => (item.tone === "danger" ? "destructive" : "default");

/** A danger item asks first; a disabled one never acts at all. */
export const rowActionNeedsConfirm = (item: {
  tone?: RowActionTone;
  confirm?: string;
  disabled?: boolean;
}): boolean => !item.disabled && item.tone === "danger" && Boolean(item.confirm);

/**
 * The FormData a server-action item posts. Built here so an item with
 * no hidden inputs still posts an empty body rather than throwing.
 */
export function rowActionFormData(hidden: readonly RowActionHidden[] | undefined): FormData {
  const fd = new FormData();
  for (const field of hidden ?? []) fd.append(field.name, field.value);
  return fd;
}

/** Only items that can actually be acted on are worth a menu. */
export const hasEnabledAction = (items: readonly { disabled?: boolean }[]): boolean =>
  items.some((item) => !item.disabled);

/**
 * Authoring mistakes, as strings. Empty means the menu is well formed.
 * Used by the unit test and by any call site that builds items from
 * data rather than by hand.
 */
export function rowActionIssues(items: readonly RowActionSpec[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.key) issues.push("an item has no key");
    else if (seen.has(item.key)) issues.push(`duplicate key: ${item.key}`);
    seen.add(item.key);
    if (!item.label) issues.push(`${item.key}: no label`);
    if (item.tone === "danger" && !item.confirm) issues.push(`${item.key}: danger without a confirm question`);
    if (item.disabled && !item.disabledReason) issues.push(`${item.key}: disabled without a reason`);
    if (!item.disabled && !item.onSelect && !item.formAction) {
      issues.push(`${item.key}: neither onSelect nor formAction`);
    }
  }
  return issues;
}
