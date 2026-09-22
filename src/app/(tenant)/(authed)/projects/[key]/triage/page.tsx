import { InboxIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { requireTenantContext } from "@/members/tenant-context";
import { listTriage } from "@/modules/work";

import { loadProject } from "../data";
import { TriageLane } from "./triage-lane";

/**
 * THE TRIAGE LANE — where a client's request gets an answer (Phase 3
 * slice 6b, work-management plan §3.1's "Accept / Decline / Duplicate /
 * Snooze").
 *
 * **WHY IT IS A ROUTE OF ITS OWN AND NOT A MODE OF THE BOARD**, which
 * the pin's phrase "triage lane on board/backlog" invites and which does
 * not survive contact with the keyboard registry. `SCOPE_ORDER`
 * (`src/lib/keymap.ts`) makes `triage` a PEER of `board` at order 10,
 * and peers "never mount together" — they are region scopes on
 * different surfaces. They cannot both be live, because `S` means "Move
 * to…" on the board and "Snooze" here, and a member pressing it would
 * get whichever scope registered last. One surface, one meaning.
 *
 * It is also the right shape for the work: triage is a QUEUE and a board
 * is a plan. The lane is ordered oldest-first, shows the client's own
 * words, and its verbs are decisions rather than moves.
 *
 * THE TAB IS HIDDEN WITHOUT `work_item:triage` (UI.md §3.1: a
 * permission-gated item is hidden, never disabled) and this page carries
 * its own gate regardless — `listTriage` calls `requireAccess`, and a
 * typed URL therefore 404s rather than rendering an empty lane. Hiding
 * a tab is never the guard.
 */
export default async function ProjectTriagePage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("projects.triage");

  // THE PAGE'S OWN GATE, and it answers a typed URL the way §7.3 says:
  // 404, never a forbidden page. A member who cannot triage must not be
  // able to tell whether this project has requests waiting — the lane's
  // emptiness is itself a fact about the client.
  let lane;
  try {
    lane = await listTriage({ tenantId: membership.tenantId, actor }, project.id);
  } catch (e) {
    // `handleAuthzRedirect` FIRST, as every sibling page does
    // (`../data.ts`, `../portal/page.tsx`): a deferred `MFA_REQUIRED`
    // must become a step-up navigation, not a 404 the member cannot act
    // on. `work_item:triage` is not a ✦ code today, so this is latent —
    // which is exactly why it is one line rather than an argument.
    handleAuthzRedirect(e, `/projects/${key}/triage`);
    if (e instanceof AuthzError) notFound();
    throw e;
  }

  return (
    <SectionCard
      title={t("title")}
      description={t("description")}
      contentClassName={lane.entries.length > 0 ? "p-0" : undefined}
    >
      {lane.entries.length === 0 ? (
        /**
         * THE NOTHING-YET STATE, AND §5.8's VERB PROBLEM SOLVED RATHER
         * THAN DODGED. That rule requires a `variant="empty"` state to
         * offer the verb that changes it — and no member can put a row
         * in this lane, because only a CLIENT can. The portal's own
         * empty state met the same wall and took `variant="forbidden"`,
         * which needs no verb.
         *
         * Here there IS a useful verb, and it is the question a member
         * standing in front of an empty lane actually has: can the
         * client submit anything at all? An empty lane usually means the
         * project's portal is off or nobody has been invited, and the
         * Portal tab is where both are answered. So a member who can
         * manage it gets that link; one who cannot gets the portal's
         * `forbidden` shape, with the inbox glyph rather than a shield —
         * a shield would say "you are blocked", which is not what an
         * empty queue means.
         *
         * The body names the one thing that is not nothing either way:
         * requests parked for later, which this list deliberately hides.
         */
        project.caps.managePortal ? (
          <EmptyState
            variant="empty"
            icon={InboxIcon}
            title={t("empty.title")}
            body={lane.snoozedCount > 0 ? t("empty.snoozed", { count: lane.snoozedCount }) : t("empty.body")}
            action={
              <Button asChild variant="outline">
                <Link href={`/projects/${project.key}/portal`}>{t("empty.action")}</Link>
              </Button>
            }
            className="py-8"
          />
        ) : (
          <EmptyState
            variant="forbidden"
            icon={InboxIcon}
            title={t("empty.title")}
            body={lane.snoozedCount > 0 ? t("empty.snoozed", { count: lane.snoozedCount }) : t("empty.body")}
            className="py-8"
          />
        )
      ) : (
        <TriageLane
          projectKey={project.key}
          projectId={project.id}
          entries={lane.entries.map((e) => ({
            id: e.id,
            number: e.number,
            key: `${project.key}-${e.number}`,
            title: e.title,
            body: e.body,
            reportedBy: e.reportedBy,
            createdAt: e.createdAt.toISOString(),
            wasSnoozed: e.snoozedUntil !== null,
          }))}
          truncated={lane.truncated}
          snoozedCount={lane.snoozedCount}
          canDecline={lane.canDecline}
        />
      )}
    </SectionCard>
  );
}
