/**
 * The one normalisation of an entry's note: trimmed, empty ⇒ null. Used
 * where a row is written (`resolveTarget`) and where two rows are
 * compared for identity (`copyRowKey`), so the stored value and the
 * comparison can never disagree. Pure — no server imports — so the
 * planner's unit test can load it.
 */
export const cleanDescription = (d: string | null | undefined): string | null => {
  const s = (d ?? "").trim();
  return s === "" ? null : s;
};
