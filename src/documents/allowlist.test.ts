import { describe, expect, it } from "vitest";

import { ALLOWED_TYPES, MAX_UPLOAD_BYTES, UploadRejectedError, validateUpload } from "./allowlist";

describe("upload allowlist (SECURITY.md §5)", () => {
  it("accepts documents, images, text and zip with their canonical type", () => {
    expect(validateUpload({ name: "a.pdf", contentType: "application/pdf", sizeBytes: 10 }))
      .toEqual({ contentType: "application/pdf", extension: "pdf" });
    expect(validateUpload({ name: "Photo.JPG", contentType: "image/jpeg", sizeBytes: 10 }).contentType)
      .toBe("image/jpeg");
    expect(validateUpload({ name: "data.csv", contentType: "text/plain", sizeBytes: 10 }).contentType)
      .toBe("text/csv");
    expect(validateUpload({ name: "x.zip", contentType: "application/x-zip-compressed", sizeBytes: 1 }).contentType)
      .toBe("application/zip");
  });

  it("stamps the canonical type when the browser sends none / octet-stream", () => {
    expect(validateUpload({ name: "notes.md", contentType: "", sizeBytes: 1 }).contentType).toBe("text/markdown");
    expect(
      validateUpload({ name: "deck.pptx", contentType: "application/octet-stream", sizeBytes: 1 }).contentType,
    ).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
  });

  it("never accepts active content — html, svg, js, exe, and friends", () => {
    for (const name of ["index.html", "logo.svg", "run.exe", "x.js", "a.htm", "b.sh", "c.php", "noext"]) {
      expect(() => validateUpload({ name, contentType: "application/octet-stream", sizeBytes: 1 })).toThrow(
        UploadRejectedError,
      );
    }
    expect(Object.keys(ALLOWED_TYPES)).not.toContain("svg");
    expect(Object.keys(ALLOWED_TYPES)).not.toContain("html");
  });

  it("rejects a MIME that disagrees with the extension", () => {
    expect(() => validateUpload({ name: "a.pdf", contentType: "text/html", sizeBytes: 1 })).toThrow(
      /does not match/,
    );
  });

  it("rejects empty, oversized and path-like names", () => {
    expect(() => validateUpload({ name: "a.pdf", contentType: "application/pdf", sizeBytes: 0 })).toThrow(
      /SIZE_INVALID/,
    );
    expect(() =>
      validateUpload({ name: "a.pdf", contentType: "application/pdf", sizeBytes: MAX_UPLOAD_BYTES + 1 }),
    ).toThrow(/SIZE_INVALID/);
    expect(() => validateUpload({ name: "../a.pdf", contentType: "application/pdf", sizeBytes: 1 })).toThrow(
      /NAME_INVALID/,
    );
  });
});
