import { expect } from "vitest";

/**
 * Lock-race helpers shared by the work module's dbtests
 * (tree-guards.dbtest.ts, comments.dbtest.ts): the pure parts of "make
 * one writer wait on another's held row and prove it waited". A test
 * file keeps its own `holdOpen` — the held body, the principal and the
 * fixture differ per file — but the assertion that a write WAITED, and
 * the error-flattening it needs, are one definition here.
 */

/** A promise that settles to its rejection (or null), so a test can hold it open without an unhandled rejection. */
export const settle = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

/** Every message an error carries — its own, its Prisma meta, and its causes (the adapter nests them). */
export function describeError(e: unknown, depth = 0): string {
  if (e === null || e === undefined || depth > 3) return "";
  const own = e instanceof Error ? e.message : String(e);
  let meta = "";
  try {
    meta = JSON.stringify((e as { meta?: unknown }).meta ?? "");
  } catch {
    meta = "";
  }
  return `${own} ${meta} ${describeError((e as { cause?: unknown }).cause, depth + 1)}`;
}

/** A write that had to wait on a row lock and gave up at `lock_timeout` (55P03). */
export async function expectLockTimeout(p: Promise<unknown>): Promise<void> {
  const err = await settle(p);
  expect(err, "the write should have WAITED on the share lock — it did not wait at all").not.toBeNull();
  expect(describeError(err)).toMatch(/lock timeout|55P03/);
}
