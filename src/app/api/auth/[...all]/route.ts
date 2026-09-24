import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/auth";
import { isMemberFlooredRequest, MEMBER_FLOOR_MS, withResponseFloor } from "@/auth/response-floor";

const handlers = toNextJsHandler(auth.handler);

export const GET = handlers.GET;

/**
 * Every POST, with two of them held to a minimum response time: SIGN-UP,
 * whose timing would otherwise tell a caller which addresses already belong
 * to a member — a new address costs two INSERTs that a registered one does
 * not — and, since C30, the RESET REQUEST, whose found and not-found branches
 * issue different statements (the portal's route floors its own for the same
 * reason). `src/auth/response-floor.ts` holds why a floor rather than a
 * balanced code path.
 *
 * Here rather than in a Better Auth hook because the floor has to cover the
 * WHOLE answer. The dbtests drive `auth.handler` directly and so run without
 * it, which is why the wiring is pinned by `response-floor.test.ts`.
 */
export const POST = withResponseFloor(handlers.POST, isMemberFlooredRequest, MEMBER_FLOOR_MS);
