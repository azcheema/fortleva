/**
 * CONTRACTS (Phase 4 step 6; founder decision C84). Slice 112: templates and
 * drafts; 112b sends and signs in the portal; 112c puts in a contract signed
 * elsewhere; 112c3 turns a signed one's reminders off and on. The design: docs/research/2026-10-10-slice-112-contracts-design.md.
 */
export {
  contractVerbs,
  CONTRACT_LIST_LIMIT,
  CONTRACT_TITLE_MAX,
  deleteContractDraft,
  listContractClients,
  listContracts,
  listContractSigners,
  readContract,
  startContract,
  updateContractDraft,
  type ContractDetail,
  type ContractListRow,
  type ContractSignatureView,
  type ContractStatus,
  type DraftPatch,
  type StartInput,
} from "./drafts";
export { FILL_IN_KEYS, fillInToken, type FillInKey } from "./fill-ins";
export { contractPreviewPdf } from "./preview";
// `ensureContractPdfAsSystem` is deliberately NOT here (slice 112b's security
// review): as SYSTEM it bypasses the portal gate, so only the announcer and the
// sweep import it, from `./pdf-store` — never a portal route.
export { contractPdfUrl, ensureContractPdf, makeMissingContractPdfs, type ContractPdfKind } from "./pdf-store";
export { setContractReminders } from "./reminders-switch";
export { changeSentContract, newContractVersion, sendContract, TYPED_NAME_MAX, withdrawContract } from "./send";
export {
  commitContractUpload,
  CONTRACT_UPLOAD_MAX_BYTES,
  deleteUploadedContract,
  presignContractUpload,
  setUploadedContractShown,
  updateUploadedContract,
  type ContractUploadCommit,
  type ContractUploadIntent,
  type ContractUploadTicket,
  type UploadedDetails,
} from "./uploads";
export type { SignerOption } from "./signers";
export {
  createContractTemplate,
  deleteContractTemplate,
  listContractTemplates,
  readContractTemplate,
  TEMPLATE_NAME_MAX,
  updateContractTemplate,
  type ContractsCtx,
  type ContractTemplateDetail,
  type ContractTemplateRow,
  type TemplateSaved,
} from "./templates";
