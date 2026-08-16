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
      const stale = await tx.fileObject.findMany({
        where: { status: "PENDING", createdAt: { lt: cutoff } },
        select: { id: true, r2Key: true },
      });
      if (stale.length === 0) return [];
      await tx.fileObject.updateMany({
        where: { id: { in: stale.map((s) => s.id) }, status: "PENDING" },
        data: { status: "DELETED" },
      });
      return stale.map((s) => s.r2Key);
    },
    { readOnly: false },
  );
  const storage = getStorage();
  await Promise.all(keys.map((k) => storage.delete(k).catch(() => undefined)));
  return { expired: keys.length };
}
