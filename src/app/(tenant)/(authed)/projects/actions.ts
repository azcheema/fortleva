"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { withTenant } from "@/db";
import { hasAccess } from "@/entitlements/resolver";
import { runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";
import type { WeekStart } from "@/lib/week";
import { requireTenantContext } from "@/members/tenant-context";
import { listAssignableMembers } from "@/modules/work";
import { readPreferences } from "@/preferences/service";
import { listProjects } from "@/projects/service";

import { createProjectFromForm } from "./create-from-form";

/** Inline create on /projects: client + key + name, and a template with its start date (slice 124). */
export async function createProjectAction(
  _prev: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const { membership, actor } = await requireTenantContext();
  const tCommon = await getTranslations("common");
  const clientId = z.uuid().safeParse(formData.get("clientId"));
  if (!clientId.success) return { ok: false, message: tCommon("invalidInput") };
  const r = await runForm("/projects", () =>
    createProjectFromForm({ tenantId: membership.tenantId, actor }, clientId.data, formData),
  );
  if (r.ok) {
    revalidatePath("/projects");
    revalidatePath(`/clients/${clientId.data}`, "layout");
  }
  return r;
}

/**
 * A project the member can aim the global `C` at. `portalEnabled` is the
 * project switch the dialog decides "who can see it" from (slice 73,
 * UI.md rule 10: the choice is asked only in a portal-enabled project).
 */
export type QuickCreateProject = { id: string; key: string; name: string; clientName: string; portalEnabled: boolean };

/**
 * The projects the shell's quick create offers (UI.md rule 2: "`C`
 * anywhere… project if inside one, else asks project first via
 * picker").
 *
 * Read on OPEN rather than rendered into the shell, the same trade
 * `pickerOptionsAction` makes: the list is only wanted once a member
 * presses the key, and shipping it on every page of the product would
 * put every project name the member can see into every HTML response.
 *
 * It is `listProjects` verbatim — the same scoped, `project:view`-gated,
 * archived-excluding read the /projects page draws — flattened out of
 * its client groups and carrying the client's name, because two clients
 * routinely have a "Website" and the picker has to be answerable.
 * Creation itself is gated where it always is, in `createItem`: this
 * list decides what the picker can OFFER, never what may be written.
 */
export async function quickCreateProjectsAction(): Promise<ActionResult<QuickCreateProject[]>> {
  const { membership, actor } = await requireTenantContext();
  return runAction("/projects", () => quickCreateProjects(membership.tenantId, actor));
}

async function quickCreateProjects(
  tenantId: string,
  actor: Awaited<ReturnType<typeof requireTenantContext>>["actor"],
): Promise<QuickCreateProject[]> {
  const groups = await listProjects({ tenantId, actor });
  return groups.flatMap((g) =>
    g.projects.map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      clientName: g.clientName,
      portalEnabled: p.portalEnabled,
    })),
  );
}

/**
 * The "New task" form's fuller half (slice 129, founder decision C106 (c)):
 * the Person list (`listAssignableMembers` — the panel's list) and the two
 * settings its due-date calendar draws by. Null for a member who may not set
 * those fields (`work_item:create` + `work_item:edit` on all four gates) —
 * the dialog then stays title-only, and `createItem` refuses the fields
 * regardless.
 */
export type QuickCreateForm = {
  readonly members: readonly { id: string; name: string }[];
  readonly weekStart: WeekStart;
  readonly showIsoWeek: boolean;
};

export type QuickCreateOptions = {
  readonly projects: QuickCreateProject[];
  readonly form: QuickCreateForm | null;
};

/** What the create dialog reads when it opens — one round trip, the project list and the form's half together. */
export async function quickCreateOptionsAction(): Promise<ActionResult<QuickCreateOptions>> {
  const { membership, actor } = await requireTenantContext();
  return runAction("/projects", async () => {
    const projects = await quickCreateProjects(membership.tenantId, actor);
    const settings = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, async (tx) => {
      // In sequence, never a batch leg (authz-batches.test.ts).
      if (!(await hasAccess(tx, membership.tenantId, actor, "work_item:create"))) return null;
      if (!(await hasAccess(tx, membership.tenantId, actor, "work_item:edit"))) return null;
      const prefs = await readPreferences(tx, membership.tenantId);
      return { weekStart: prefs.weekStart, showIsoWeek: prefs.showIsoWeek };
    });
    if (settings === null) return { projects, form: null };
    const members = await listAssignableMembers({ tenantId: membership.tenantId, actor });
    return { projects, form: { ...settings, members } };
  });
}
