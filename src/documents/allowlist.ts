/**
 * Server-side upload allowlist (SECURITY.md §5, T2): extension AND MIME
 * must both be known and agree. Active content (html/svg/js/exe/…) is
 * never accepted — SVG deliberately excluded until an inline-render
 * policy exists. Everything is later served as attachment regardless.
 */

const TEXT_ALIASES = ["text/plain"];

/** extension → accepted MIME types (first = canonical). */
export const ALLOWED_TYPES: Readonly<Record<string, readonly string[]>> = {
  // images
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  // documents
  pdf: ["application/pdf"],
  doc: ["application/msword"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xls: ["application/vnd.ms-excel"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ppt: ["application/vnd.ms-powerpoint"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  odt: ["application/vnd.oasis.opendocument.text"],
  ods: ["application/vnd.oasis.opendocument.spreadsheet"],
  odp: ["application/vnd.oasis.opendocument.presentation"],
  // text / data
  txt: ["text/plain"],
  csv: ["text/csv", ...TEXT_ALIASES, "application/vnd.ms-excel"],
  md: ["text/markdown", ...TEXT_ALIASES],
  json: ["application/json", ...TEXT_ALIASES],
  // archives
  zip: ["application/zip", "application/x-zip-compressed"],
};

/** Hard per-file cap for a single presigned PUT (multipart is v2). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export class UploadRejectedError extends Error {
  constructor(
    readonly code: "TYPE_NOT_ALLOWED" | "SIZE_INVALID" | "NAME_INVALID",
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "UploadRejectedError";
  }
}

const extensionOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : "";
};

// path separators and control bytes are what we reject
const BAD_NAME_CHARS = /[\/\x00-\x1f]/;

/**
 * Validate a proposed upload and return the CANONICAL content type to
 * store and sign — never the client's string verbatim.
 */
export function validateUpload(input: {
  name: string;
  contentType: string;
  sizeBytes: number;
}): { contentType: string; extension: string } {
  const name = input.name.trim();
  if (!name || name.length > 255 || BAD_NAME_CHARS.test(name)) {
    throw new UploadRejectedError(
      "NAME_INVALID",
      "file name is empty, too long or contains path characters",
    );
  }
  const ext = extensionOf(name);
  const accepted = ALLOWED_TYPES[ext];
  if (!ext || !accepted) {
    throw new UploadRejectedError("TYPE_NOT_ALLOWED", `.${ext || "?"} files are not accepted`);
  }
  const mime = input.contentType.split(";")[0]!.trim().toLowerCase();
  // Browsers send an empty or generic type for many files — accept and
  // stamp the canonical type for the extension.
  const generic = mime === "" || mime === "application/octet-stream";
  if (!generic && !accepted.includes(mime)) {
    throw new UploadRejectedError("TYPE_NOT_ALLOWED", `${mime} does not match .${ext}`);
  }
  if (
    !Number.isInteger(input.sizeBytes) ||
    input.sizeBytes <= 0 ||
    input.sizeBytes > MAX_UPLOAD_BYTES
  ) {
    throw new UploadRejectedError("SIZE_INVALID", `size must be 1..${MAX_UPLOAD_BYTES} bytes`);
  }
  return { contentType: accepted[0]!, extension: ext };
}
