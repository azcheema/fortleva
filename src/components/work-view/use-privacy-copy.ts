import { useFormatter, useTranslations } from "next-intl";

import type { PrivacyPreview } from "@/modules/work";

/**
 * The sharing UI's copy (Phase 3 slice 72), ONE place for the three
 * surfaces that ask about a make-private — the item rail, the backlog's
 * cell and the selection bar — so "2 tasks under it, 3 comments and 1
 * file" and the sentences under a question cannot drift between them.
 *
 * `partsOf` names only the NON-ZERO parts and joins them with the
 * locale's own conjunction (`format.list`: Swedish "och", no Oxford
 * comma) — each part is its own plural message, because a sentence with
 * a plural per noun would start its branches with a word, which the i18n
 * parity test reads as an argument name (AGENTS.md).
 *
 * `detailsOf` says what else is true: tasks handed to someone at the
 * client come off their list (and a re-share does not hand them back);
 * a sign-off request is hidden with its file, not withdrawn; published
 * time reports and updates keep what they said — or, with the project's
 * portal off, that the client sees none of it either way. The question
 * never promises more than the product does.
 */
export function usePrivacyCopy() {
  const t = useTranslations("visibility");
  const format = useFormatter();
  const partsOf = (p: { below: number; comments: number; files: number }, under: "it" | "them"): string =>
    format.list(
      [
        ...(p.below ? [t(under === "it" ? "parts.belowIt" : "parts.belowThem", { count: p.below })] : []),
        ...(p.comments ? [t("parts.comments", { count: p.comments })] : []),
        ...(p.files ? [t("parts.files", { count: p.files })] : []),
      ],
      { type: "conjunction" },
    );
  /** The project's portal is off: the client sees none of it either way (count-neutral — a bar asks about many). */
  const portalOff = (): string => t("ask.portalOff");
  const detailsOf = (p: PrivacyPreview): string[] => [
    ...(p.handedOver ? [t("ask.handedOver", { count: p.handedOver })] : []),
    ...(p.awaitingSignoff ? [t("ask.signoff", { count: p.awaitingSignoff })] : []),
    p.portalEnabled ? t("ask.frozen") : portalOff(),
  ];
  /** Anything below the selection that would go private with it. */
  const hasBelow = (p: { below: number; comments: number; files: number }) => p.below + p.comments + p.files > 0;
  return { partsOf, detailsOf, hasBelow, portalOff };
}
