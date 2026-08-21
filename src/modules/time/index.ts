/**
 * Public API of the time module (ARC-16: cross-module imports go
 * through this barrel only; direction time → work → core).
 */
export type { TimeCtx } from "./ctx";
export { ensureTimeDefaults, resetTimeDefaultsMemo } from "./bootstrap";
export {
  STAFF_NOTICE_PURPOSES,
  STAFF_NOTICE_SEED,
  acknowledgeNotice,
  getCurrentNoticeTexts,
  getNoticeStatus,
  listNoticeAcknowledgments,
  publishNotice,
  type NoticeStatus,
  type NoticeTexts,
  type NoticeView,
} from "./notice";
export {
  WORK_TYPE_SEEDS,
  createWorkType,
  listWorkTypes,
  setWorkTypeArchived,
  updateWorkType,
  type WorkTypeRow,
} from "./work-types";
export {
  COST_REVEAL_WINDOW_MINUTES,
  closeRateCard,
  createRateCard,
  listBillRateCards,
  listCostRateCards,
  repriceRateCard,
  revealCostRates,
  type RateCardView,
  type RateKind,
  type RateScope,
  type RateSnapshot,
  type RateSource,
} from "./rates";
export {
  UNDO_WINDOW_SECONDS,
  continueEntry,
  getCurrentTimer,
  startTimer,
  stopTimer,
  undoStart,
  type CurrentTimer,
  type TimerEntry,
} from "./timer";
export {
  createEntry,
  deleteEntry,
  listMyEntries,
  listTeamEntries,
  updateEntry,
  type CreateEntryInput,
  type EntryListRow,
  type EntryPatch,
} from "./entries";
export {
  clockIn,
  clockOut,
  getCurrentShift,
  listMyShifts,
  listTeamShiftTotals,
  startBreak,
  stopBreak,
  updateShift,
  type CurrentShift,
  type ShiftBreakRow,
  type ShiftRow,
  type TeamDayTotal,
} from "./shifts";
export { settleMember, settleMemberOnce, settleTenant, type SettleResult } from "./settle";
export { recomputeProjectMonth } from "./summary";
export type { EntryTargetInput, ResolvedTarget } from "./target";
export {
  archiveBudget,
  checkBudgetAlerts,
  createBudget,
  currentPeriod,
  getProjectBudget,
  updateBudget,
  type BudgetBurn,
  type BudgetInput,
  type BudgetKind,
  type BudgetPeriod,
  type BudgetView,
  type BillingModel,
} from "./budgets";
export {
  agreementConsumption,
  projectRollup,
  teamRollup,
  type ProjectRollup,
  type Range,
  type RollupLine,
  type TeamRollupLine,
} from "./rollup";
export { projectMoney, type MoneyLine, type MoneyTotals, type ProjectMoney } from "./money";
export {
  archiveReport,
  deleteReport,
  generateReport,
  getReport,
  listReports,
  publishReport,
  regenerateReport,
  unpublishReport,
  type ReportGroupBy,
  type ReportLine,
  type ReportSnapshot,
  type ReportStatus,
  type ReportView,
} from "./reports";
