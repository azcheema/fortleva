import Link from "next/link";

import { entityInitials, entityStyle } from "@/lib/entity-color";
import { cn } from "@/lib/utils";

/**
 * A client or a project, wherever one is referenced. The tile colour is
 * derived from the IMMUTABLE id (src/lib/entity-color.ts), so the same
 * workspace always wears the same dot — identity, never status.
 *
 * The initials are decorative (aria-hidden): the name beside them is
 * the accessible content, exactly as with a logo. That is also why the
 * tile is allowed to sit at the 3:1 non-text threshold rather than the
 * 4.5:1 text one.
 */
export function EntityChip({
  id,
  name,
  entityKey,
  kind,
  size = "sm",
  href,
  className,
}: {
  id: string | null | undefined;
  name: string;
  /** Project key (ACME) — rendered in the mono face with lining figures. */
  entityKey?: string | null;
  kind: "client" | "project";
  size?: "sm" | "md";
  href?: string;
  className?: string;
}) {
  const tile = (
    <span
      aria-hidden="true"
      style={entityStyle(id, name)}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-sm bg-(--entity) font-semibold text-entity-ink",
        size === "md" ? "size-5 text-2xs" : "size-4 text-[0.5625rem] leading-none",
      )}
    >
      {entityInitials(name)}
    </span>
  );

  const body = (
    <>
      {tile}
      <span className="truncate">{name}</span>
      {entityKey ? (
        <span className="num shrink-0 font-mono text-xs text-muted-foreground">{entityKey}</span>
      ) : null}
    </>
  );

  const classes = cn(
    "inline-flex min-w-0 items-center gap-1.5 text-sm text-foreground",
    href && "rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    className,
  );

  if (href) {
    return (
      <Link href={href} data-slot="entity-chip" data-kind={kind} className={classes}>
        {body}
      </Link>
    );
  }
  return (
    <span data-slot="entity-chip" data-kind={kind} className={classes}>
      {body}
    </span>
  );
}
