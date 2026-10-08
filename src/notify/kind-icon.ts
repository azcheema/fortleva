import {
  AtSignIcon,
  CalendarClockIcon,
  CircleCheckIcon,
  ClipboardCheckIcon,
  FileClockIcon,
  GaugeIcon,
  InboxIcon,
  KeyRoundIcon,
  KeySquareIcon,
  MegaphoneIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  ShieldAlertIcon,
  UserRoundPlusIcon,
  type LucideProps,
} from "lucide-react";

import type { NotificationKind } from "./catalog";

/**
 * One glyph per kind (UI.md §10) — the inbox's rows and `/home`'s inbox
 * card draw the same one. A row written by a newer deploy (`kind: null`)
 * takes the generic bell at the call site. A `Record`, so a kind added
 * without a glyph is a type error, the discipline `kind-copy.ts` records.
 */
export const KIND_ICON: Record<NotificationKind, React.ComponentType<LucideProps>> = {
  "work_item.assigned": UserRoundPlusIcon,
  "comment.mentioned": AtSignIcon,
  "work_item.commented": MessageSquareIcon,
  "work_item.request_received": InboxIcon,
  "work_item.completed_by_contact": CircleCheckIcon,
  "work_item.client_commented": MessagesSquareIcon,
  "approval.decided": ClipboardCheckIcon,
  "budget.threshold_reached": GaugeIcon,
  // The Renewals rail entry's glyph, so the reminder and the page match.
  "expiration.asset_due": CalendarClockIcon,
  "expiration.agreement_ending": FileClockIcon,
  "expiration.logins_expiring": KeyRoundIcon,
  "credential.submitted": KeySquareIcon,
  "credential.ask_declined": KeySquareIcon,
  "contact.logins_alarm": ShieldAlertIcon,
  // The Updates tab's own glyph (its empty state), so the reminder and the tab match.
  "project_update.due": MegaphoneIcon,
};
