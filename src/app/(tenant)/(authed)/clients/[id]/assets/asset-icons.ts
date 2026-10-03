import {
  AppWindowIcon,
  BadgeCheckIcon,
  BoxIcon,
  GlobeIcon,
  type LucideIcon,
  MailIcon,
  NetworkIcon,
  PlugIcon,
  ServerIcon,
  ShieldCheckIcon,
} from "lucide-react";

import type { AssetType } from "@/modules/vault";

/**
 * One glyph per asset type — the Assets tab's rows and `/expirations`
 * draw the same one (directive-free: imported by a client row and a server
 * page alike; the vault import is a type and erases).
 */
export const ASSET_ICON: Readonly<Record<AssetType, LucideIcon>> = {
  DOMAIN: GlobeIcon,
  HOSTING: ServerIcon,
  DNS_ZONE: NetworkIcon,
  SSL_CERT: ShieldCheckIcon,
  EMAIL: MailIcon,
  CMS_APP: AppWindowIcon,
  THIRD_PARTY_SERVICE: PlugIcon,
  LICENSE: BadgeCheckIcon,
  CUSTOM: BoxIcon,
};
