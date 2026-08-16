import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";

/**
 * The two-token visibility badge (UI.md §5.5): "Private to team"
 * (neutral) or "Client can see" (accent) — never a third wording, never
 * an icon alone. Works in server and client components.
 */
export function VisibilityBadge({ visibility }: { visibility: "INTERNAL" | "CLIENT_VISIBLE" }) {
  const t = useTranslations("visibility");
  return visibility === "CLIENT_VISIBLE" ? (
    <Badge className="bg-blue-50 text-blue-700">{t("clientVisible")}</Badge>
  ) : (
    <Badge variant="secondary">{t("internal")}</Badge>
  );
}
