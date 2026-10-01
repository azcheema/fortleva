import { randomBytes } from "node:crypto";

import { activeRootKeyId, decryptField, encryptField } from "./root-keyring";

/**
 * Per-tenant key MATERIAL, and nothing else (SECURITY.md §6.1). One place
 * builds a tenant's first key row, so the lazy path (`tenant-key.ts`,
 * on a tenant's first encrypt) and the release back-fill
 * (`tenant-key-backfill.ts`, from `prisma/seed.ts`) cannot drift apart in
 * key id, DEK size or wrapping. It imports the root keyring alone — no
 * database, no audit, no request context — because the seed loads it
 * with an owner client and no tenant transaction around it.
 */

export const DEK_BYTES = 32;
export const FIRST_KEY_ID = "t1";

/** A fresh random DEK, wrapped (v1 format) by the ACTIVE env root key. */
export function mintFirstTenantKey(): { keyId: string; rootKeyId: string; wrappedDek: string } {
  const dek = randomBytes(DEK_BYTES);
  return {
    keyId: FIRST_KEY_ID,
    rootKeyId: activeRootKeyId(),
    wrappedDek: encryptField(dek.toString("base64")),
  };
}

/**
 * PROOF THAT THIS PROCESS HOLDS THE DEPLOYMENT'S ROOT KEYRING, before it
 * wraps anything (both reviews, 2026-10-01). The seed loads `.env.local`
 * first, so a release run with `DIRECT_URL` pointed at production from a
 * shell holding the DEV keyring would otherwise install ACTIVE keys the
 * application can never unwrap — and the lazy path, finding an ACTIVE row,
 * would never replace them. Every given wrapped DEK must unwrap to 32
 * bytes under this keyring — the first that does not throws, naming only
 * its position — AND at least one must be wrapped under this process's
 * ACTIVE root key id, which is the key a mint would use: decryption also
 * accepts `FIELD_ENCRYPTION_KEY_PREVIOUS`, so a shell mid-rotation (a new
 * active key the deployment does not hold yet, the deployment's key as
 * "previous") would otherwise pass and then mint under the unknown key
 * (final review, 2026-10-01). An empty list proves nothing and throws.
 * The caller passes the database's newest keys.
 */
export function assertKeyringUnwraps(wrappedDeks: readonly string[]): void {
  if (wrappedDeks.length === 0) throw new Error("tenant-key: no tenant key to prove the root keyring against");
  const active = activeRootKeyId();
  if (!wrappedDeks.some((w) => w.startsWith(`v1.${active}.`))) {
    throw new Error(
      "tenant-key: none of the database's newest tenant keys is wrapped under this process's ACTIVE root key — refusing to mint keys with it (mid-rotation? run it after the deployment has the new key and the keys are re-wrapped)",
    );
  }
  wrappedDeks.forEach((wrapped, i) => {
    let ok = false;
    try {
      ok = Buffer.from(decryptField(wrapped), "base64").length === DEK_BYTES;
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new Error(
        `tenant-key: this process's root keyring does not unwrap the database's existing tenant key #${i + 1} — refusing to mint keys with it`,
      );
    }
  });
}
