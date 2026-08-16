import type { NextRequest } from "next/server";

import { isProduction } from "@/config";
import { getStorage, LocalDiskTransport } from "@/storage";

/**
 * Dev-only stand-in for the R2 endpoint: the LocalDiskTransport's
 * "presigned" URLs land here. Signature (HMAC in the query) is the ONLY
 * authorization — like a real presigned URL, no session is involved.
 * Refuses in production and when the active transport is not local.
 */

const local = (): LocalDiskTransport | null => {
  if (isProduction) return null;
  const s = getStorage();
  return s instanceof LocalDiskTransport ? s : null;
};

const keyOf = (segments: string[]): string => segments.map(decodeURIComponent).join("/");

export async function PUT(request: NextRequest, ctx: RouteContext<"/api/dev-storage/[...key]">) {
  const t = local();
  if (!t) return new Response("not found", { status: 404 });
  const { key } = await ctx.params;
  return t.handlePut(request, keyOf(key));
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/dev-storage/[...key]">) {
  const t = local();
  if (!t) return new Response("not found", { status: 404 });
  const { key } = await ctx.params;
  return t.handleGet(request, keyOf(key));
}
