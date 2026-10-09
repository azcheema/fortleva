/**
 * Next rejects a server action's promise with its redirect (an expired
 * session's `requireTenantContext`, a step-up), then navigates by itself — so
 * a client `catch` around an action call must let it pass silently rather
 * than toast "couldn't reach Fortleva" over a page that is already leaving.
 * (Several components keep a local copy of this; new ones use this one.)
 */
export const isActionRedirect = (e: unknown): boolean => {
  const digest = typeof e === "object" && e !== null ? (e as { digest?: unknown }).digest : undefined;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
};
