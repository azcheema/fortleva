import { DomainError, type DomainErrorCode } from "@/lib/domain-error";

/**
 * Database-raised invariants → DomainError, one table per module. A
 * hand-written trigger RAISEs with a stable leading token (`TOKEN: text`);
 * partial uniques and EXCLUDE constraints surface as Prisma P2002 / raw
 * errors whose message names the index. Anything unmatched is rethrown
 * untouched — a bug, not a business rule.
 *
 * Tokens are matched as substrings, so within one table no token may be
 * a substring of another's (`dbErrorMapper` refuses such a table).
 */
export type DbErrorTokens = readonly (readonly [token: string, code: DomainErrorCode])[];

export function dbErrorMapper(tokens: DbErrorTokens) {
  for (const [a] of tokens) {
    for (const [b] of tokens) {
      if (a !== b && b.includes(a)) throw new Error(`db error token "${a}" is a substring of "${b}"`);
    }
  }

  function mapDbError(e: unknown): never {
    const message = e instanceof Error ? e.message : String(e);
    // Prisma 7 + the pg adapter: for a hand-written partial unique the
    // top-level message says "Unique constraint failed on the (not
    // available)" and `meta.target` is absent — the constraint name is
    // only in meta.driverAdapterError.cause.originalMessage. Scan the
    // whole meta rather than one field, so every token is found wherever
    // the adapter happens to put it.
    let meta = "";
    try {
      meta = JSON.stringify((e as { meta?: unknown } | null)?.meta ?? "");
    } catch {
      meta = "";
    }
    for (const [token, code] of tokens) {
      if (message.includes(token) || meta.includes(token)) throw new DomainError(code);
    }
    throw e;
  }

  /** Run a transaction body and translate DB-raised invariants. */
  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      return mapDbError(e);
    }
  }

  return { mapDbError, guarded };
}
