/**
 * The vault module (Phase 3V; DATA_MODEL.md §6.17; plan §3.4). Imported
 * through this file only. Direction: `vault → core`, never another module.
 */
export {
  ASSET_FIELDS,
  ASSET_TYPES,
  isAssetStatus,
  isAssetType,
  type AssetFieldKind,
  type AssetFieldSpec,
  type AssetStatus,
  type AssetType,
} from "./asset-fields";
export {
  createAsset,
  deleteAsset,
  listAssets,
  updateAsset,
  type AssetFieldValue,
  type AssetFieldValues,
  type AssetPatch,
  type AssetView,
  type CreateAssetInput,
} from "./assets";
export type { VaultCtx } from "./ctx";
export {
  EXPIRATIONS_DAYS,
  expirationsFeed,
  expirationsGlance,
  GLANCE_DAYS,
  type ExpirationEntry,
  type ExpirationKind,
  type ExpirationsFeed,
  type ExpirationsGlance,
  type LoginExpirations,
} from "./expirations";
export { openVault, type OpenVault, type VaultAbilities } from "./door";
export { REMINDER_BANDS, isReminderBand, type ReminderBand } from "./reminder-bands";
export {
  REMINDER_KINDS,
  isReminderKind,
  reminderSubjects,
  type ReminderKind,
  type ReminderRef,
  type ReminderSubject,
} from "./reminder-subjects";
export { sendExpirationReminders, type ReminderRun } from "./reminders";
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
export {
  createShareLink,
  listShareLinks,
  revokeShareLink,
  SHARE_LIST_LIMIT,
  SHARE_STEP_UP_MINUTES,
  type CreatedShareLink,
  type CreateShareLinkInput,
  type ShareLinkStatus,
  type ShareLinkView,
} from "./share-links";
export {
  openShareLink,
  previewShareLink,
  sendShareCode,
  type ShareCodeMail,
  type ShareCodeOutcome,
  type SharedSecret,
  type ShareOpenOutcome,
  type SharePreview,
} from "./share-open";
export {
  hideLoginFromClient,
  showLoginToClient,
  SHOW_STEP_UP_MINUTES,
} from "./visibility";
export { sealLogin, unsealLogin } from "./seal";
export { listPortalLogins, PORTAL_LOGIN_LIMIT, portalLoginsShown, type PortalLogin } from "./portal";
export {
  LOGINS_CODES_PER_HOUR,
  LOGINS_UNLOCKS_PER_DAY,
  LOGINS_UNLOCKS_PER_HOUR,
  lookAtPortalLogin,
  openPortalLoginsDoor,
  readPortalLoginsDoor,
  resendPortalLoginsCode,
  startPortalLoginsDoor,
  type DoorOpenOutcome,
  type DoorResendOutcome,
  type DoorStartOutcome,
  type LoginsCodeMail,
  type OpenPortalDoor,
  type PasswordCheck,
  type PortalDoorState,
  type PortalLoginsCtx,
  type PortalLookOutcome,
} from "./portal-writes";
