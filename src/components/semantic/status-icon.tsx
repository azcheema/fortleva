import {
  ArchiveIcon,
  BanIcon,
  BugIcon,
  CheckIcon,
  CircleCheckBigIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CirclePauseIcon,
  CircleXIcon,
  ClockAlertIcon,
  ClockIcon,
  CornerDownRightIcon,
  EyeIcon,
  FilePenIcon,
  FlagIcon,
  GlobeIcon,
  InboxIcon,
  InfoIcon,
  LayersIcon,
  LockIcon,
  MailCheckIcon,
  MailQuestionMarkIcon,
  MailXIcon,
  MinusIcon,
  OctagonAlertIcon,
  PackageCheckIcon,
  SquareCheckIcon,
  TriangleAlertIcon,
  Undo2Icon,
  UserRoundIcon,
  UserRoundXIcon,
  type LucideProps,
} from "lucide-react";

import type { StatusIconName } from "@/lib/enum-map";

/**
 * One icon per state, resolved from the serialisable name in
 * src/lib/enum-map.ts. The silhouettes are deliberately different from
 * each other (dashed / dotted / paused / ticked / crossed), because the
 * release gate is a GREYSCALE screenshot of a mixed list: if two states
 * are only a hue apart, the pass has failed.
 */
const ICONS: Record<StatusIconName, React.ComponentType<LucideProps>> = {
  "circle-check": CircleCheckIcon,
  "circle-check-big": CircleCheckBigIcon,
  "circle-dashed": CircleDashedIcon,
  "circle-dot": CircleDotIcon,
  "circle-pause": CirclePauseIcon,
  "circle-x": CircleXIcon,
  archive: ArchiveIcon,
  "file-pen": FilePenIcon,
  "package-check": PackageCheckIcon,
  minus: MinusIcon,
  clock: ClockIcon,
  "clock-alert": ClockAlertIcon,
  check: CheckIcon,
  "undo-2": Undo2Icon,
  lock: LockIcon,
  eye: EyeIcon,
  "user-round": UserRoundIcon,
  "user-round-x": UserRoundXIcon,
  "mail-question": MailQuestionMarkIcon,
  "mail-check": MailCheckIcon,
  "mail-x": MailXIcon,
  "triangle-alert": TriangleAlertIcon,
  "octagon-alert": OctagonAlertIcon,
  flag: FlagIcon,
  "square-check": SquareCheckIcon,
  bug: BugIcon,
  inbox: InboxIcon,
  layers: LayersIcon,
  "corner-down-right": CornerDownRightIcon,
  globe: GlobeIcon,
  info: InfoIcon,
  ban: BanIcon,
};

export function StatusIcon({ name, ...props }: { name: StatusIconName } & LucideProps) {
  const Icon = ICONS[name];
  return <Icon aria-hidden="true" {...props} />;
}
