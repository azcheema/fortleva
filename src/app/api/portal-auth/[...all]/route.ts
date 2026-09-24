import { toNextJsHandler } from "better-auth/next-js";

import { portalAuth } from "@/auth/portal";
import { isPortalResetRequest, RESET_REQUEST_FLOOR_MS, withResponseFloor } from "@/auth/response-floor";

const handlers = toNextJsHandler(portalAuth.handler);

export const GET = handlers.GET;

/**
 * Every POST, with one of them held to a minimum response time: the reset
 * REQUEST, whose timing would otherwise tell a caller which addresses belong
 * to some agency's client list. `src/auth/response-floor.ts` holds why a
 * floor rather than a balanced code path.
 *
 * Here, at the route, rather than in a Better Auth hook, because the floor
 * has to cover the WHOLE answer — the library's branch, our hooks, and the
 * response serialisation — and this is the one place that sees all of it.
 * The dbtests drive `portalAuth.handler` directly and so run without it,
 * which is why the floor has its own unit test.
 */
export const POST = withResponseFloor(handlers.POST, isPortalResetRequest, RESET_REQUEST_FLOOR_MS);
