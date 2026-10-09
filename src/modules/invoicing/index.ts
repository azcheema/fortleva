/**
 * The invoicing module (Phase 4 — DATA_MODEL.md §6.7; founder decision C75).
 * Pages and actions import from here.
 */
export {
  addLine,
  createDraft,
  deleteDraft,
  DETAIL_TEXT_MAX,
  getInvoice,
  INVOICE_LIST_LIMIT,
  LINE_LIMIT,
  LINE_TEXT_MAX,
  listInvoiceableClients,
  listInvoices,
  moveLine,
  removeLine,
  setDraftVatProfile,
  updateDraftDetails,
  updateLine,
  type BillTo,
  type DraftDetailsPatch,
  type InvoiceDetail,
  type InvoiceLineView,
  type InvoiceListRow,
  type InvoiceStatus,
  type LineInput,
  type LineParse,
} from "./drafts";
export {
  formatFixed,
  invoiceTotals,
  minorToNumber,
  rateToNumber,
  type InvoiceTotals,
  type Minor,
  type VatGroup,
} from "./money";
export {
  BANK_FIELDS,
  COMPANY_FIELDS,
  PAYMENT_FIELDS,
  readInvoiceSettings,
  updateCompanyDetails,
  updateDefaultPaymentTerms,
  updatePaymentDetails,
  INVOICE_DETAILS_STEP_UP_MINUTES,
  normalizeCompanyPatch,
  normalizePaymentPatch,
  type BankField,
  type CompanyDetails,
  type CompanyField,
  type CompanyPatch,
  type InvoiceSettings,
  type MissingDetail,
  type PaymentDetails,
  type PaymentField,
  type PaymentPatch,
} from "./seller";
export {
  FOOTER_NOTE_MAX,
  PAYMENT_TERMS_DEFAULT,
  PAYMENT_TERMS_RANGE,
  SELLER_TEXT_MAX,
  vatNumberFor,
} from "./seller-fields";
export { defaultRateFor, isVatProfile, VAT_PROFILES, VAT_RATES, type VatProfile } from "./vat";
// Phase 4 slice 108 — issuing (founder decision C76).
export { issueInvoice, type IssueBlocker, type IssueCheck, type IssueCheckSeen } from "./issue";
export { type IssuedInvoice } from "./issued";
// NOT the PDF store (`./pdf-store`): it reaches `@react-pdf/renderer`, an
// ESM-only package a CommonJS importer of this index cannot load — the e2e
// fixture CLI runs under tsx as CommonJS and imports this index. The invoice
// actions and the jobs route import `@/modules/invoicing/pdf-store` directly.
export {
  isInvoiceLocale,
  printAmount,
  printFxRate,
  type InvoiceLocale,
  type InvoicePrint,
} from "./print";
export { FIRST_NUMBER_MAX, setFirstInvoiceNumber, type Numbering } from "./series";
