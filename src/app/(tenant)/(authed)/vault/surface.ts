/**
 * WHERE A VAULT FORM CAME FROM, AND WHERE ITS LOGIN GOES (Phase 3V slice 86).
 * A directive-free, import-free module: the three vault pages' client
 * components build these strings, and the server actions parse them back.
 *
 * - A **surface** is the page a form was posted from — the one the action
 *   revalidates and the one the step-up sends the member back to. It is a
 *   CLOSED set of three shapes, never a free path: an action must not
 *   redirect wherever a form says.
 * - A **where** is the anchor a new login hangs on: the agency itself
 *   (C49), a client as a whole, or one project. The vault's service checks
 *   scope and the anchor's own facts; this only reads the shape.
 */

export type VaultSurface = `client:${string}` | `project:${string}` | "tenant";

/** The client's Vault tab. */
export const clientSurface = (clientId: string): VaultSurface => `client:${clientId}`;
/** A project's Vault tab. */
export const projectSurface = (key: string): VaultSurface => `project:${key}`;
/** The tenant's `/vault`. */
export const TENANT_SURFACE: VaultSurface = "tenant";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * `PROJECT_KEY_RE` (`src/projects/service.ts`), restated because that module
 * reaches the database and this one is bundled for the browser;
 * `surface.test.ts` holds the two together.
 */
export const SURFACE_PROJECT_KEY = /^[A-Z][A-Z0-9]{0,7}$/;

/** `kind:id` split exactly once — anything with a second colon is no shape of ours. */
function split(raw: unknown): readonly [string, string] | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const at = raw.indexOf(":");
  if (at < 0 || raw.indexOf(":", at + 1) >= 0) return null;
  return [raw.slice(0, at), raw.slice(at + 1)];
}

/** The page a posted surface names, or null for anything that is not one of the three. */
export function vaultPathOf(raw: unknown): string | null {
  if (raw === TENANT_SURFACE) return "/vault";
  const parts = split(raw);
  if (!parts) return null;
  const [kind, id] = parts;
  if (kind === "client" && UUID.test(id)) return `/clients/${id.toLowerCase()}/vault`;
  if (kind === "project" && SURFACE_PROJECT_KEY.test(id)) return `/projects/${id}/vault`;
  return null;
}

export type VaultWhere = { readonly clientId: string | null; readonly projectId: string | null };

/** The agency's own login (C49) — the one `where` with no id. */
export const AGENCY_WHERE = "agency";
export const clientWhere = (clientId: string) => `client:${clientId}`;
export const projectWhere = (projectId: string) => `project:${projectId}`;

/** The anchor a posted `where` names, or null for anything else. */
export function vaultWhereOf(raw: unknown): VaultWhere | null {
  if (raw === AGENCY_WHERE) return { clientId: null, projectId: null };
  const parts = split(raw);
  if (!parts) return null;
  const [kind, id] = parts;
  if (!UUID.test(id)) return null;
  if (kind === "client") return { clientId: id, projectId: null };
  if (kind === "project") return { clientId: null, projectId: id };
  return null;
}
