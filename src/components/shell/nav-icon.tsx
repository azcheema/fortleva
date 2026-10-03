import {
  ArchiveIcon,
  Building2Icon,
  CoinsIcon,
  FolderIcon,
  FolderKanbanIcon,
  HouseIcon,
  BellIcon,
  CalendarClockIcon,
  InboxIcon,
  SearchIcon,
  KeyRoundIcon,
  PaletteIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  TimerIcon,
  UserRoundIcon,
  UsersIcon,
  VaultIcon,
  type LucideProps,
} from "lucide-react";

import type { NavIcon as NavIconName } from "@/app/(tenant)/(authed)/nav";

/** One icon per concept, reused everywhere (UI.md §10). */
const ICONS: Record<NavIconName, React.ComponentType<LucideProps>> = {
  home: HouseIcon,
  inbox: InboxIcon,
  search: SearchIcon,
  clients: Building2Icon,
  projects: FolderKanbanIcon,
  time: TimerIcon,
  files: FolderIcon,
  // Not the key: that glyph is Roles' (and a login row's), and one icon
  // means one concept (UI.md §10).
  vault: VaultIcon,
  renewals: CalendarClockIcon,
  members: UsersIcon,
  settings: SettingsIcon,
  roles: KeyRoundIcon,
  preferences: SlidersHorizontalIcon,
  rates: CoinsIcon,
  // Same glyph as the rail's Time entry: one icon per concept.
  timeSettings: TimerIcon,
  // A bell is "reach me", the inbox tray is "what reached me": two
  // concepts, two glyphs.
  notifications: BellIcon,
  export: ArchiveIcon,
  design: PaletteIcon,
  account: UserRoundIcon,
};

export function NavIcon({ name, ...props }: { name: NavIconName } & LucideProps) {
  const Icon = ICONS[name];
  return <Icon aria-hidden="true" {...props} />;
}
