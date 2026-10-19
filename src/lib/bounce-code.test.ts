import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

import { isOwnMessage, parseBounce, withBounce } from "./bounce-code";

/**
 * `?error=` is a CODE the page looks up, never a sentence it draws (slice 137).
 * What reaches the page is whatever a link held, so everything that is not a
 * code of ours must read as nothing.
 */

describe("parseBounce", () => {
  it("reads a files key and a domain key", () => {
    expect(parseBounce("files.notFound")).toEqual({ catalogue: "files", key: "notFound" });
    expect(parseBounce("domain.SIGNOFF_OPEN")).toEqual({ catalogue: "domain", key: "SIGNOFF_OPEN" });
  });

  it("reads free text, an unknown catalogue, a path and a repeated parameter as nothing", () => {
    for (const raw of [
      "The file could not be downloaded. Try again.",
      "Your session expired — sign in again at example.com",
      "notFound",
      "NOT_FOUND",
      "other.notFound",
      "files.",
      "domain.",
      "files.not found",
      "files.errors.notFound",
      "domain.NOT_FOUND.x",
      "files.NOT_FOUND",
      "domain.notFound",
      `files.${"a".repeat(65)}`,
      `domain.${"A".repeat(65)}`,
      "",
      undefined,
      null,
      ["files.notFound", "files.forbidden"],
      42,
    ]) {
      expect(parseBounce(raw), String(raw)).toBeNull();
    }
  });
});

describe("isOwnMessage", () => {
  it("takes the catalogue's own strings only — never an inherited name or a nested object", () => {
    const catalogue = { notFound: "File not found.", nested: { a: "b" } };
    expect(isOwnMessage(catalogue, "notFound")).toBe(true);
    for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf", "nested", "missing"]) {
      expect(isOwnMessage(catalogue, key), key).toBe(false);
    }
    expect(isOwnMessage(undefined, "notFound")).toBe(false);
    expect(isOwnMessage("notFound", "length")).toBe(false);
  });

  it("finds the codes written as literals — the type checks only their catalogue's name — in BOTH languages", () => {
    // AuthzError's five readings (`domainMessageKey`) and the export
    // actions' `domain.INVALID_INPUT`; the files keys are typed by `t()`.
    for (const messages of [en, sv]) {
      for (const key of ["FORBIDDEN", "NOT_FOUND", "NOT_ENTITLED", "FEATURE_DISABLED", "DISABLED_BY_TENANT", "INVALID_INPUT"]) {
        expect(isOwnMessage(messages.domainErrors, key), key).toBe(true);
      }
    }
  });
});

describe("withBounce", () => {
  it("adds the code after any query the path already has", () => {
    expect(withBounce("/files", "files.notFound")).toBe("/files?error=files.notFound");
    expect(withBounce("/tasks?item=WEB-3", "domain.SIGNOFF_OPEN")).toBe("/tasks?item=WEB-3&error=domain.SIGNOFF_OPEN");
  });

  it("every code it writes reads back", () => {
    const back = new URL(withBounce("/files", "domain.NOT_FOUND"), "https://x.invalid").searchParams.get("error");
    expect(parseBounce(back)).toEqual({ catalogue: "domain", key: "NOT_FOUND" });
  });
});
