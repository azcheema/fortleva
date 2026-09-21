import {
  AtSignIcon,
  GaugeIcon,
  InboxIcon,
  MessageSquareIcon,
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
  "budget.threshold_reached": GaugeIcon,
};
