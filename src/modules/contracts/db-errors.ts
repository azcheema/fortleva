import { dbErrorMapper } from "@/lib/db-error-map";

/**
 * The contract guards' tokens (migration 20261011120000) a member can reach
 * through a service. Every draft verb locks its contract `FOR UPDATE` and
 * re-reads its status first, so these are the belt for a race.
 *
 * Unmapped on purpose, so they surface as bugs: `CONTRACT_GUARD` and
 * `CONTRACT_TEMPLATE_GUARD` (a write no service makes — a member acting as
 * someone else, a frozen column changed, a status moved in slice 112, a
 * contact writing). The services ask for the code before either can fire.
 */
export const { mapDbError, guarded } = dbErrorMapper([
  ["CONTRACT_NOT_DRAFT", "CONTRACT_NOT_DRAFT"],
  ["CONTRACT_SIGNER_INVALID", "CONTRACT_SIGNER_INVALID"],
  // The case-insensitive name index — asked first (`assertNameFree`), so the
  // race's belt.
  ["contract_template_name_key", "CONTRACT_TEMPLATE_NAME_TAKEN"],
  // The body's size CHECKs — the normaliser's cap comes first, so these are
  // the belt (never a token inside another: `contract_body` is not inside
  // `contract_template_body`).
  ["contract_template_body", "CONTRACT_TOO_LARGE"],
  ["contract_body", "CONTRACT_TOO_LARGE"],
]);
