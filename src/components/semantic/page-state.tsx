import type { LucideProps } from "lucide-react";

import { EmptyState, type EmptyStateVariant } from "@/components/empty-state";
import { Page } from "@/components/page-header";
import { SectionCard } from "@/components/semantic/section-card";

/**
 * ONE COMPONENT FOR EVERY WHOLE-PAGE STATE (UI.md §10.15 pattern 6).
 *
 * The 404s, the error boundary and the unavailable-invite page are four
 * renderings of a single idea, and all four had drifted: a 22px h1 on
 * one and a 14px h1 on another for the SAME sentence, a card on one and
 * bare canvas on the next, two actions here and none there.
 *
 * Rules this fixes in place:
 *  - the title is the page's h1, at the page-title size (§10.7);
 *  - the block sits on a `SectionCard`, because §10.15 pattern 6
 *    requires the surface for a whole-page denial;
 *  - a primary action is REQUIRED (§5.8) — a dead end is not a state,
 *    it is an omission;
 *  - it starts at the content column's normal top, left-aligned, so it
 *    lines up with the header and the cards of every other route. No
 *    `min-h` / `justify-center` gymnastics.
 */
export type PageStateProps = {
  variant: EmptyStateVariant;
  icon: React.ComponentType<LucideProps>;
  title: string;
  body: string;
  /** REQUIRED: a whole-page state always offers a way forward (§5.8). */
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  /**
   * "bare" drops the `<Page>` wrapper for the anonymous routes, which
   * keep the `AuthShell` lockup as their chrome but take their title
   * scale, their card and their mandatory action from here.
   */
  chrome?: "page" | "bare";
};

export function PageState({
  variant,
  icon,
  title,
  body,
  primary,
  secondary,
  chrome = "page",
}: PageStateProps) {
  const block = (
    <SectionCard>
      <EmptyState
        variant={variant}
        icon={icon}
        titleAs="h1"
        title={title}
        body={body}
        action={primary}
        secondary={secondary}
      />
    </SectionCard>
  );
  return chrome === "bare" ? block : <Page width="default">{block}</Page>;
}
