import { withPlatform } from "@/db";
import { getStorage } from "@/storage";

/**
 * Reconciliation job for the documents service (src/jobs — the one
 * place besides the platform plane and src/db that may use
 * withPlatform, ARC-16 import boundary).
 */

/**
 * Stale PENDING objects (presigned but never committed) release their
 * quota reservation: mark DELETED and best-effort remove any bytes.
 * Cross-tenant by nature ⇒ system job under withPlatform (audited
 * there). Called manually for now; cron in a later phase.
 */
export async function expirePendingUploads(
  olderThanMinutes: number,
): Promise<{ expired: number }> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const keys = await withPlatform(
    { type: "system", job: "expire-pending-uploads" },
    `expire PENDING file objects older than ${olderThanMinutes} min`,
    async (tx) => {
      // ONE statement, and only the rows IT flipped hand back their key (the
      // slice-112c pre-apply review): a SELECT then an UPDATE deleted the
      // bytes of every row the SELECT saw — a commit landing between the two
      // kept its row COMMITTED and lost its file for good.
      const flipped = await tx.$queryRaw<{ r2_key: string }[]>`
        UPDATE file_object SET status = 'DELETED'
         WHERE status = 'PENDING' AND created_at < ${cutoff}
        RETURNING r2_key`;
      return flipped.map((r) => r.r2_key);
    },
    { readOnly: false },
  );
  const storage = getStorage();
  await Promise.all(keys.map((k) => storage.delete(k).catch(() => undefined)));
  return { expired: keys.length };
}
