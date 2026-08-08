import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  decryptField,
  encryptField,
  isEncryptedField,
  resetKeyringCache,
} from "./field-encryption";

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");

beforeEach(() => {
  process.env["FIELD_ENCRYPTION_KEY"] = KEY;
  process.env["FIELD_ENCRYPTION_KEY_ID"] = "k1";
  delete process.env["FIELD_ENCRYPTION_KEY_PREVIOUS"];
  resetKeyringCache();
});

afterEach(() => {
  resetKeyringCache();
});

describe("field encryption (SECURITY.md §6)", () => {
  it("round-trips and produces the v1.<keyId>.<iv>.<ct>.<tag> format", () => {
    const ct = encryptField("JBSWY3DPEHPK3PXP");
    expect(ct.split(".")).toHaveLength(5);
    expect(ct.startsWith("v1.k1.")).toBe(true);
    expect(isEncryptedField(ct)).toBe(true);
    expect(decryptField(ct)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("same plaintext encrypts differently every time (fresh IV)", () => {
    expect(encryptField("x")).not.toBe(encryptField("x"));
  });

  it("tampered ciphertext fails authentication", () => {
    const ct = encryptField("secret");
    const parts = ct.split(".");
    const body = parts[3] ?? "";
    const flipped = (body[0] === "A" ? "B" : "A") + body.slice(1);
    const tampered = [parts[0], parts[1], parts[2], flipped, parts[4]].join(".");
    expect(() => decryptField(tampered)).toThrow();
  });

  it("key rotation: previous key still decrypts, new key encrypts", () => {
    const oldCt = encryptField("legacy");
    process.env["FIELD_ENCRYPTION_KEY"] = OTHER_KEY;
    process.env["FIELD_ENCRYPTION_KEY_ID"] = "k2";
    process.env["FIELD_ENCRYPTION_KEY_PREVIOUS"] = `k1:${KEY}`;
    resetKeyringCache();

    expect(decryptField(oldCt)).toBe("legacy");
    expect(encryptField("fresh").startsWith("v1.k2.")).toBe(true);
  });

  it("rejects unknown formats and unknown keyIds", () => {
    expect(() => decryptField("v2.k1.a.b.c")).toThrow(/unknown format/);
    expect(() => decryptField("v1.k9.YQ.YQ.YQ")).toThrow(/no key/);
  });

  it("rejects a wrongly sized key", () => {
    process.env["FIELD_ENCRYPTION_KEY"] = Buffer.from("short").toString("base64");
    resetKeyringCache();
    expect(() => encryptField("x")).toThrow(/32 bytes/);
  });
});
