import { randomUUID } from "node:crypto";

import type { TenantDb } from "@/db";

import type { CredentialType } from "./fields";
import { insertSecretRow } from "./secret-store";

/**
 * THE ROW A CLIENT'S HAND-OVER WRITES (Phase 3V slice 96; founder decision
 * C64) — the INSERT behind the portal's submission broker
 * (`submission-portal-writes.ts`), kept out of the broker's own file for
 * the reason the request intake keeps `createRequest` out of its broker
 * (`src/modules/work/requests.ts`): the broker is read by the portal
 * tripwires as a portal surface, and the write names columns a portal
 * surface may not. This file is in the tripwire's STRUCTURAL tier
 * (`src/authz/portal-projections.test.ts`), so a select-less read or an
 * include added here later still trips it.
 *
 * Every value arrives already NORMALIZED by the broker (`fields.ts`), and
 * every identifying column is the broker's: the client is the contact's
 * own, the project one the broker re-read as that client's, the contact the
 * principal's. What it writes, and the migration's guard holds for any
 * writer (20261006180000): a login for the team only (INTERNAL), not
 * sealed, no authenticator seed (C59 (d)'s rule for clients, and nothing on
 * the form asks for one), no member as its author — `submittedByContactId`
 * says who sent it, and a member's later edits stamp `updatedByMemberId`
 * as on any login. `lastRotatedAt` is now: the secret is as new as it gets.
 */
export type SubmittedCredential = {
  readonly tenantId: string;
  readonly clientId: string;
  readonly projectId: string | null;
  readonly contactId: string;
  readonly type: CredentialType;
  readonly name: string;
  readonly username: string | null;
  readonly url: string | null;
  readonly notes: string | null;
  /** The type's secret fields, at least one, values untouched. */
  readonly fields: Record<string, string>;
};

/** Write the login and its encrypted secret; the id is minted here because the AAD binds the ciphertext to it. */
export async function insertSubmittedCredential(tx: TenantDb, input: SubmittedCredential): Promise<{ id: string }> {
  const id = randomUUID();
  await tx.credentialItem.create({
    data: {
      id,
      tenantId: input.tenantId,
      clientId: input.clientId,
      projectId: input.projectId,
      type: input.type,
      name: input.name,
      username: input.username,
      url: input.url,
      tags: [],
      notes: input.notes,
      secretFieldKeys: Object.keys(input.fields),
      hasTotp: false,
      visibility: "INTERNAL",
      lastRotatedAt: new Date(),
      submittedByContactId: input.contactId,
      // What the client's own list shows, for good: the team may rename the
      // login, and its new name is the team's, never the client's to read.
      submittedName: input.name,
    },
    select: { id: true },
  });
  await insertSecretRow(tx, {
    tenantId: input.tenantId,
    credentialId: id,
    fields: input.fields,
    totp: null,
    memberId: null,
  });
  return { id };
}
