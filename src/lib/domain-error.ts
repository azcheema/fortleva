/**
 * Business-rule failures that are neither authorization denials
 * (AuthzError) nor bugs: the caller (server action) maps `code` to an
 * i18n message. Codes are a closed union so the UI catalog stays exact.
 */
export type DomainErrorCode =
  | "NAME_REQUIRED"
  | "KEY_INVALID" // Project.key must match ^[A-Z][A-Z0-9]{0,7}$
  | "KEY_TAKEN" // Project.key unique per tenant
  | "EMAIL_INVALID"
  | "EMAIL_TAKEN" // Contact.email unique
  | "VERSION_TAKEN" // ProjectVersion.version unique per project
  | "ALREADY_SHIPPED"
  | "ARCHIVED" // mutation on an archived client/project
  | "CLIENT_MISMATCH" // projectId does not belong to clientId
  | "INVALID_INPUT";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "DomainError";
  }
}

export const fail = (code: DomainErrorCode, detail?: string): never => {
  throw new DomainError(code, detail);
};

/** Prisma unique-violation duck test (no runtime import of the client — one-seam rule). */
export const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
