import {
  ArchiveIcon,
  Building2Icon,
  CoinsIcon,
  FolderIcon,
  FolderKanbanIcon,
  HouseIcon,
  KeyRoundIcon,
  PaletteIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  TimerIcon,
  UserRoundIcon,
  UsersIcon,
  type LucideProps,
} from "lucide-react";

import type { NavIcon as NavIconName } from "@/app/(tenant)/(authed)/nav";

/** One icon per concept, reused everywhere (UI.md §10). */
const ICONS: Record<NavIconName, React.ComponentType<LucideProps>> = {
  home: HouseIcon,
  clients: Building2Icon,
  projects: FolderKanbanIcon,
  time: TimerIcon,
  files: FolderIcon,
  members: UsersIcon,
  settings: SettingsIcon,
  roles: KeyRoundIcon,
  preferences: SlidersHorizontalIcon,
  rates: CoinsIcon,
  // Same glyph as the rail's Time entry: one icon per concept.
  timeSettings: TimerIcon,
  export: ArchiveIcon,
  design: PaletteIcon,
  account: UserRoundIcon,
};

export function NavIcon({ name, ...props }: { name: NavIconName } & LucideProps) {
  const Icon = ICONS[name];
  return <Icon aria-hidden="true" {...props} />;
}
