import { toNextJsHandler } from "better-auth/next-js";

import { platformAuth } from "@/auth/platform";

export const { GET, POST } = toNextJsHandler(platformAuth.handler);
