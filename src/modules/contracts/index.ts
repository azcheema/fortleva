/**
 * CONTRACTS (Phase 4 step 6; founder decision C84). Slice 112: templates and
 * drafts; 112b sends and signs in the portal; 112c puts in a contract signed
 * elsewhere. The design: docs/research/2026-10-10-slice-112-contracts-design.md.
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
  type ContractStatus,
  type DraftPatch,
  type StartInput,
} from "./drafts";
export { FILL_IN_KEYS, fillInToken, type FillInKey } from "./fill-ins";
export { contractPreviewPdf } from "./preview";
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
