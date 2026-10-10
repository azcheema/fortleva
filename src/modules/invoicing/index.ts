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
  CREDIT_REASON_MAX,
  type BillTo,
  type CreditSummary,
  type DraftDetailsPatch,
  type InvoiceDetail,
  type InvoiceKind,
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
export { issueInvoice, type IssueBlocker, type IssueCheck, type IssueCheckSeen, type OverCredit } from "./issue";
// Phase 4 slice 108b — credit notes (founder decisions C76 (c), (f), C77).
export { createCreditDraft, creditInFull, type CreditedInFull } from "./credit";
export { type CreditNoteSummary } from "./credit-state";
export { type RateNets } from "./issue-check";
export { type IssuedInvoice } from "./issued";
// NOT the PDF store (`./pdf-store`): it reaches `@react-pdf/renderer`, an
// ESM-only package a CommonJS importer of this index cannot load — the e2e
// fixture CLI runs under tsx as CommonJS and imports this index. The invoice
// actions and the jobs route import `@/modules/invoicing/pdf-store` directly.
export {
  isInvoiceLocale,
  printAmount,
  printFxRate,
  printQuantity,
  signed,
  type InvoiceLocale,
  type InvoicePrint,
} from "./print";
export { FIRST_NUMBER_MAX, setFirstInvoiceNumber, type Numbering } from "./series";
// Phase 4 slice 110 — hours onto invoices (founder decisions C75 (a), (b), C80).
export {
  addHoursToDraft,
  clearHourMarks,
  createInvoiceFromHours,
  forLine,
  HOURS_PAGE_MAX,
  isHourMark,
  listReadyToInvoice,
  markHours,
  readClientHours,
  returnHours,
  type ClientHours,
  type ClientHoursFilter,
  type HourMark,
  type HoursAdded,
  type MarkedHour,
  type ReadyClient,
  type ReadyHour,
} from "./hours";
export {
  billedSeconds,
  hoursLines,
  hoursQuantity,
  isLineGrouping,
  isRoundingMode,
  isRoundingStep,
  LINE_GROUPINGS,
  ROUNDING_MINIMUM_MAX,
  ROUNDING_MODES,
  ROUNDING_STEPS,
  roundingRuleOf,
  type HourForLine,
  type HoursLine,
  type LineGrouping,
  type LineTexts,
  type RoundingMode,
  type RoundingRule,
  type RoundingStep,
} from "./hours-lines";
export { INVOICE_HOURS_CARD_MAX, type InvoiceHourRow, type InvoiceHours, type InvoiceHourState } from "./hours-record";
// Phase 4 slice 110b — the time breakdown page on the PDF (founder decisions C80 (d), C81).
export { HOURS_PAGE_ROWS_MAX, printedTask, printHoursMinutes, type HoursPagePrint, type HoursPagePrintLine } from "./hours-page";
// Phase 4 slice 111 — the bookkeeping file for Fortnox (founder decision C82);
// slice 111b — the cash method's year end (C83).
export {
  bookYearEnd,
  createExport,
  EXPORT_FILES_PAGE,
  exportFile,
  readBookkeeping,
  readBookkeepingSettingsPage,
  readNewestYearEnd,
  readYearEndReminder,
  updateBookkeepingSettings,
  YEAR_END_PREVIEW,
  type BookkeepingFile,
  type BookkeepingPage,
  type BookkeepingSettingsPage,
  type ExportFormat,
  type MadeFile,
  type YearEndBooked,
} from "./bookkeeping";
export {
  ACCOUNT_ROLES,
  BOOKKEEPING_DEFAULTS,
  BOOKKEEPING_FIELDS,
  BOOKKEEPING_METHODS,
  isBookkeepingField,
  type AccountRole,
  type BookkeepingField,
  type BookkeepingMethod,
  type BookkeepingSettings,
} from "./bookkeeping-accounts";
export { LIST_COLUMNS, LIST_EVENTS, type ListColumn, type ListEvent, type ListRemark, type ListWords } from "./invoice-list";
