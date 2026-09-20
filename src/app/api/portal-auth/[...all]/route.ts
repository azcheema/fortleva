import { toNextJsHandler } from "better-auth/next-js";

import { portalAuth } from "@/auth/portal";

export const { GET, POST } = toNextJsHandler(portalAuth.handler);
