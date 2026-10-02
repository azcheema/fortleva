/**
 * The vault module (Phase 3V; DATA_MODEL.md §6.17; plan §3.4). Imported
 * through this file only. Direction: `vault → core`, never another module.
 */
export type { VaultCtx } from "./ctx";
export { openVault, type OpenVault, type VaultAbilities } from "./door";
export { CREDENTIAL_TYPES, SECRET_FIELDS, isCredentialType, type CredentialType } from "./fields";
export {
  createCredential,
  deleteCredential,
  getCredential,
  listAllCredentials,
  listCredentials,
  replaceCredentialSecret,
  updateCredential,
  vaultIndex,
  VAULT_LIST_LIMIT,
  type CreateCredentialInput,
  type CredentialFilter,
  type CredentialListing,
  type CredentialPatch,
  type CredentialView,
  type VaultIndex,
} from "./items";
export { copyCredentialField, generateCredentialTotp, revealCredentialField, type RevealKind } from "./reveal";
