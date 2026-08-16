import {
  ArchiveIcon,
  Building2Icon,
  FolderIcon,
  FolderKanbanIcon,
  HouseIcon,
  KeyRoundIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
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
  files: FolderIcon,
  members: UsersIcon,
  settings: SettingsIcon,
  roles: KeyRoundIcon,
  preferences: SlidersHorizontalIcon,
  export: ArchiveIcon,
  account: UserRoundIcon,
};

export function NavIcon({ name, ...props }: { name: NavIconName } & LucideProps) {
  const Icon = ICONS[name];
  return <Icon aria-hidden="true" {...props} />;
}
