import {
  authorizePortal,
  withPortalRead,
  type PortalCapability,
  type PortalPrincipal,
} from "@/portal";

/**
 * THE PROJECTS A CONTACT CAN SEE, AS A CONTACT SEES THEM — two columns.
 *
 * It exists because the request form has to ask "which project is this
 * about", and a picker is a projection like any other: the list of names
 * a client is shown is the list of names the agency has published to
 * them, and nothing else. Putting it here rather than deriving it from
 * `listPortalTasks` is deliberate — a client whose project has nothing
 * shared in it yet still has that project, and still needs to be able
 * to ask for something in it. Deriving the picker from the task list
 * would have made "you have no shared tasks" silently mean "you may not
 * ask us for anything".
 *
 * WHAT BOUNDS IT IS THE POLICY, not this `where`. `project`'s
 * `portal_gate` is `client_id = app.client_id AND portal_enabled`
 * (migration 20260816180000), so under the contact principal this read
 * can only ever return portal-enabled projects of the contact's own
 * client. The filter below repeats the archive term the policy does NOT
 * have — the same gap `listPortalTasks` documents at length: archiving a
 * project leaves `portalEnabled` TRUE, so without this line an agency
 * that archived a finished project would go on inviting requests into
 * it for ever.
 *
 * NO COUNT, NO DATES, NO STATUS. A picker needs a name and a value. A
 * project's own status is the agency's word for where its work stands
 * and is not on UI.md §11's "shown to a contact" side; adding it here
 * because a select-list looked bare is exactly how a projection grows.
 */

/** One row of the request form's project picker. */
export type PortalProjectOption = {
  readonly id: string;
  readonly name: string;
};

/**
 * ORDERED BY NAME, not by anything the agency decides. There is no
 * "recent" and no "active first": both would publish a fact about how
 * the agency works, and a client with four projects reads an
 * alphabetical list without being told anything.
 */
export type PortalProjectRef = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
};

/**
 * ONE PROJECT OF THE CONTACT'S OWN CLIENT, BY ITS KEY — the resolver a
 * portal route under `/portal/projects/[key]` starts with. The key is
 * the project's public handle ("ACME"), already on every task the client
 * reads; what this proves is that THIS contact may see THIS project
 * (`portal_gate` on `project` binds client + `portal_enabled`), and it
 * answers null — the plane's one uniform "nothing" — for any key that is
 * not theirs, switched off, or archived. The route treats null exactly
 * as it treats an empty list.
 */
export async function findPortalProjectByKey(
  principal: PortalPrincipal,
  key: string,
): Promise<PortalProjectRef | null> {
  const upper = key.toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(upper)) return null;
  return withPortalRead(principal, async (tx) => {
    await authorizePortal(tx, principal, "portal.project.view");
    return tx.project.findFirst({
      where: {
        tenantId: principal.tenantId,
        clientId: principal.clientId,
        key: upper,
        portalEnabled: true,
        archivedAt: null,
      },
      select: { id: true, key: true, name: true },
    });
  });
}

export async function listPortalProjects(
  principal: PortalPrincipal,
  /**
   * THE CAPABILITY THIS LIST IS *FOR*, and it is required rather than
   * defaulted. A picker is only ever rendered as the first field of
   * something, and a contact who may not do that something must not be
   * shown a form that will refuse them at the end of it — they get the
   * portal's one uniform empty answer instead, at the top, like every
   * other refusal on this plane. Making the caller name the verb is what
   * keeps the two in step: the page and the action ask the same
   * question.
   */
  capability: PortalCapability,
): Promise<readonly PortalProjectOption[]> {
  return withPortalRead(principal, async (tx) => {
    // No ref on either: every row this returns is gated individually by
    // `portal_gate`, and naming one project would be inventing a
    // resource the query does not have (`PortalScopeRef`). The contact
    // row behind both checks is read once per transaction
    // (`authorizePortal` memoises it), so the second is free.
    await authorizePortal(tx, principal, "portal.project.view");
    await authorizePortal(tx, principal, capability);
    return tx.project.findMany({
      where: {
        tenantId: principal.tenantId,
        clientId: principal.clientId,
        portalEnabled: true,
        archivedAt: null,
      },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
  });
}
