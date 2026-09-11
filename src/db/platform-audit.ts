import {
  platformAuditRow,
  type AuditRequestContext,
  type PlatformAuditInput,
} from "@/audit/platform-record";
import { getRequestContext } from "@/lib/request-context";

import { getPlatformClient } from "./client";

/**
 * Write ONE platform-plane audit row.
 *
 * WHY IT CANNOT GO THROUGH `record()`. That function refuses twice over
 * — no tenant context, and PLATFORM-visibility actions from tenant
 * context — and both refusals are correct. Underneath them is a database
 * fact: `audit_tenant_insert` carries `WITH CHECK (tenant_id =
 * app.tenant_id)`, so `app_runtime` cannot insert `tenant_id IS NULL` at
 * all. A platform-plane row needs `app_platform`, and this is the only
 * new path to it.
 *
 * WHY IT IS NOT `withPlatform()`. That helper writes an audit row about
 * ITSELF on every invocation — `platform.tenant_access` or
 * `platform.system_job`, with a mandatory `reason`. Routing audit writes
 * through it would make every console sign-in produce two rows, one of
 * them describing the act of recording the other. This takes the same
 * connection without the self-describing row.
 *
 * FAILURE IS THE CALLER'S TO SWALLOW, and every caller does: the auth
 * sinks wrap this in `guarded()`. Nothing here catches, because a silent
 * failure inside the writer would hide a broken audit trail from the
 * logs as well as from the operator. Note `getPlatformClient()` is
 * called HERE rather than at module load, so importing this file is free
 * and a missing PLATFORM_DATABASE_URL surfaces as a logged failure with
 * a working console, not a console that will not boot.
 */
export async function recordPlatformEvent(input: PlatformAuditInput): Promise<void> {
  // Built and validated BEFORE any connection is opened, so a bad action
  // costs nothing and fails the same way with or without a database.
  const req = (await getRequestContext()) as AuditRequestContext | undefined;
  const row = platformAuditRow(input, req);
  await getPlatformClient().auditEvent.create({ data: row });
}
