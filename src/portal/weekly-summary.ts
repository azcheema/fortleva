import { AuthzError } from "@/authz/errors";
import { listPortalDocuments, listPortalPendingDeliverables } from "@/documents/portal";
import { countPortalLoginAsks } from "@/modules/vault";
import { isWaitingOnYou, listPortalAgencyReplies, listPortalTasks, listPortalUpdates } from "@/modules/work";
import type { ClientDigestCounts } from "@/notify/client-digest";
import { listPortalPendingVersions } from "@/projects/portal";

import type { PortalPrincipal } from "./authorize";

/** How many projections a summary reads — all refused means the person sees no portal at all. */
const READS = 7;

/**
 * WHAT ONE CLIENT PERSON'S WEEKLY SUMMARY COUNTS (Phase 5 slice 101; founder
 * decision C69 (b), (c)) — every number taken from the portal's OWN
 * projections, run as that person.
 *
 * THIS FILE QUERIES NO TABLE. Each count is a projection the portal already
 * draws from — the home's cards, the project page's "Waiting on you", the
 * files list — called with the person's principal, so each runs in its own
 * `withPortalRead` transaction under the CONTACT principal, where `portal_gate`
 * decides before any `where` does. The summary therefore cannot count a row
 * the person's portal would not show them: an INTERNAL update, another
 * client's file, a project whose portal is off, an area their profile or
 * their agency's plan closes. That is SECURITY.md §5.1's View-as argument
 * made for mail — "a separate preview renderer is how previews lie" — and a
 * summary that counted through a query of its own would be that renderer.
 *
 * A REFUSAL COUNTS ZERO. `authorizePortal` refuses an area the person may not
 * see (a collaborator's sign-offs, the vault module switched off), and "you
 * may not see it" is, for a count, "there is none". Only `AuthzError` is
 * swallowed: a dead connection must fail the run, never mail a zero. And when
 * EVERY read is refused — the person paused, or the portal module switched
 * off, since the job — the answer is NULL, not zeros (the code review's low):
 * that summary is no longer wanted, and must not pass for one with nothing to
 * say, which would chain the next summary past news nobody was told.
 *
 * NEW is `[since, until)`; WAITING is now, however old. In SEQUENCE: each
 * projection opens its own transaction, and nothing here races.
 */
export async function countClientSummary(
  principal: PortalPrincipal,
  since: Date,
  until: Date,
): Promise<ClientDigestCounts | null> {
  let refused = 0;
  /** A projection's answer, or null when the person may not see that area. */
  const quiet = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (e) {
      if (!(e instanceof AuthzError)) throw e;
      refused += 1;
      return null;
    }
  };
  const inWindow = (at: Date): boolean => at.getTime() >= since.getTime() && at.getTime() < until.getTime();

  // NEW: the updates the home's cards would show (the Updates switch
  // followed, C47), published since the last summary.
  const updates = await quiet(() => listPortalUpdates(principal, { followSectionSwitches: true, publishedSince: since }));
  // NEW: "Your agency replied" — a shared task whose newest comment the person
  // can see is the agency's and still unanswered — replied since the last
  // summary. The card's own window is `PORTAL_REPLY_WINDOW_DAYS` (14): a
  // summary whose chain reaches further back — last week's dropped unsent —
  // counts only the replies the card itself still shows, which is the rule.
  const replies = await quiet(() => listPortalAgencyReplies(principal));
  // NEW: files whose newest committed version arrived since the last summary
  // — a new file or a new version. A file made visible long after its upload
  // is not "new" here: the list knows when its bytes arrived, not when it was
  // shared (recorded in DATA_MODEL §6.18 item 9).
  const files = await quiet(() => listPortalDocuments(principal));
  // WAITING: what is asked of THIS person's decision — empty, not refused,
  // for a profile that cannot sign (the projections' own rule).
  const versions = await quiet(() => listPortalPendingVersions(principal));
  const deliverables = await quiet(() => listPortalPendingDeliverables(principal));
  // WAITING: tasks given to this person that they have not ticked — the
  // project page's "Waiting on you" set, whatever the Tasks switch says
  // (C47b), less the ones they already said were done.
  const tasks = await quiet(() => listPortalTasks(principal));
  // WAITING: logins the agency asked this person for — the home's count.
  const logins = await quiet(() => countPortalLoginAsks(principal));
  if (refused === READS) return null;

  return {
    updates: (updates ?? []).filter((u) => inWindow(u.publishedAt)).length,
    replies: (replies ?? []).filter((r) => inWindow(r.repliedAt)).length,
    files: (files?.documents ?? []).filter((d) => inWindow(d.version.at)).length,
    signoffs: (versions?.length ?? 0) + (deliverables?.length ?? 0),
    tasks: (tasks?.projects ?? []).flatMap((p) => p.tasks).filter((t) => isWaitingOnYou(t) && t.markedDoneAt === null)
      .length,
    logins: logins ?? 0,
  };
}

