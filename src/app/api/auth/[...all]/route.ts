import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/auth";
import { isSignUpRequest, SIGN_UP_FLOOR_MS, withResponseFloor } from "@/auth/response-floor";

const handlers = toNextJsHandler(auth.handler);

export const GET = handlers.GET;

/**
 * Every POST, with one of them held to a minimum response time: SIGN-UP,
 * whose timing would otherwise tell a caller which addresses already belong
 * to a member — a new address costs two INSERTs that a registered one does
 * not. `src/auth/response-floor.ts` holds why a floor rather than a balanced
 * code path, and the portal's route does the same for its reset request.
 *
 * Here rather than in a Better Auth hook because the floor has to cover the
 * WHOLE answer. The dbtests drive `auth.handler` directly and so run without
 * it, which is why the wiring is pinned by `response-floor.test.ts`.
 */
export const POST = withResponseFloor(handlers.POST, isSignUpRequest, SIGN_UP_FLOOR_MS);
