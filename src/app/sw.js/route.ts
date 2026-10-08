import { headers } from "next/headers";

import { planeForHost } from "@/config";
import { serviceWorkerSource } from "@/pwa/service-worker";

/**
 * Serves the service worker (decision 15 / ARC-25) — its source, the
 * pass-through cache rules (Stage A) and the push handlers (Stage B, Phase 5
 * slice 106), lives in `src/pwa/service-worker.ts`. Served from a route (not
 * /public) so the ops host can refuse it: the platform plane is deliberately
 * un-installable, and gets no push either.
 */
const VERSION = process.env["VERCEL_GIT_COMMIT_SHA"]?.slice(0, 12) ?? process.env["NEXT_PUBLIC_APP_VERSION"] ?? "dev";

const WORKER = serviceWorkerSource(VERSION);

export async function GET(): Promise<Response> {
  const host = (await headers()).get("host") ?? "";
  if (planeForHost(host) !== "app") return new Response("Not found", { status: 404 });
  return new Response(WORKER, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // The worker script itself is never cached by the browser beyond a
      // revalidation: a deploy must reach installed apps on the next visit.
      "Cache-Control": "no-cache, max-age=0, must-revalidate",
      "Service-Worker-Allowed": "/",
    },
  });
}
