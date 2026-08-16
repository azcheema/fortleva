import { entityInitials, entityStyle } from "@/lib/entity-color";
import { cn } from "@/lib/utils";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";

/**
 * A person, wherever one is shown. The fallback carries the same
 * deterministic entity colour as EntityChip (src/lib/entity-color.ts),
 * so the same member wears the same wash on every screen.
 *
 * DEVIATION from DESIGN SPEC §6, deliberate: the spec puts the entity
 * colour on the *initials*. The entity ramp is anchored to 3:1 (a
 * non-text threshold), so coloured initials on a tint of their own hue
 * measure ~3:1 and fail SC 1.4.3. The wash carries the identity and the
 * initials stay --foreground, which measures ≥10:1 in both themes.
 */
export function MemberAvatar({
  id,
  name,
  size = "sm",
  className,
}: {
  id: string | null | undefined;
  name: string;
  size?: "sm" | "default" | "lg";
  className?: string;
}) {
  return (
    <Avatar size={size} title={name} className={className}>
      <AvatarFallback
        style={entityStyle(id, name)}
        className={cn("entity-tint text-foreground")}
      >
        {entityInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
