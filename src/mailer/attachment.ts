import { createHash } from "node:crypto";

/** A file sent WITH a message — an issued invoice's PDF, and nothing else (C79 (a)). */
export type MailAttachment = {
  readonly filename: string;
  readonly contentType: "application/pdf";
  readonly content: Uint8Array;
};

/**
 * What the dev outbox says about a message's attachments: each file's name,
 * type, size and sha-256 — NEVER its bytes (slice 109). The outbox file is a
 * convenience a test reads; an invoice PDF carries bank details, and a log
 * line is not where its bytes belong.
 */
export const describeAttachments = (attachments: readonly MailAttachment[] | undefined) =>
  attachments?.map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    size: a.content.byteLength,
    sha256: createHash("sha256").update(a.content).digest("hex"),
  }));
