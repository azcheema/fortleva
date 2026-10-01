import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encryptField, resetKeyringCache } from "./root-keyring";
import { DEK_BYTES, FIRST_KEY_ID, assertKeyringUnwraps, mintFirstTenantKey } from "./tenant-key-material";

/**
 * The tenant-key material and the back-fill's keyring PROOF, database-free.
 * The proof is what stops a release seed run from the wrong shell — the
 * dev keyring against the production database — from installing ACTIVE
 * keys the application can never unwrap (reviews, 2026-10-01).
 */

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");

const useKeyring = (key: string, id = "k1") => {
  process.env["FIELD_ENCRYPTION_KEY"] = key;
  process.env["FIELD_ENCRYPTION_KEY_ID"] = id;
  delete process.env["FIELD_ENCRYPTION_KEY_PREVIOUS"];
  resetKeyringCache();
};

beforeEach(() => useKeyring(KEY));
afterEach(() => resetKeyringCache());

describe("mintFirstTenantKey", () => {
  it("is key t1, wrapped under the ACTIVE root key, and unwraps to a 32-byte DEK", () => {
    const minted = mintFirstTenantKey();
    expect(minted.keyId).toBe(FIRST_KEY_ID);
    expect(minted.rootKeyId).toBe("k1");
    expect(minted.wrappedDek.startsWith("v1.k1.")).toBe(true);
    expect(() => assertKeyringUnwraps([minted.wrappedDek])).not.toThrow();
  });
});

describe("assertKeyringUnwraps", () => {
  it("passes for keys this keyring wrapped under its ACTIVE key; refuses an empty list — nothing proves nothing", () => {
    expect(() => assertKeyringUnwraps([mintFirstTenantKey().wrappedDek, mintFirstTenantKey().wrappedDek])).not.toThrow();
    expect(() => assertKeyringUnwraps([])).toThrow(/no tenant key to prove/);
  });

  it("refuses a shell MID-ROTATION: the deployment's key as PREVIOUS unwraps everything, but a mint would use the unknown ACTIVE one", () => {
    const theirs = mintFirstTenantKey().wrappedDek; // the deployment's: v1.k1 under KEY
    useKeyring(OTHER_KEY, "k2");
    process.env["FIELD_ENCRYPTION_KEY_PREVIOUS"] = `k1:${KEY}`;
    resetKeyringCache();
    expect(() => assertKeyringUnwraps([theirs])).toThrow(/ACTIVE root key/);
  });

  it("refuses when ANOTHER keyring wrapped the database's keys — even under the same key id", () => {
    const theirs = mintFirstTenantKey().wrappedDek; // the deployment's keyring
    useKeyring(OTHER_KEY); // this shell's, also called "k1"
    expect(() => assertKeyringUnwraps([theirs])).toThrow(/does not unwrap the database's existing tenant key #1/);
  });

  it("refuses a key wrapped under a root key id this keyring does not hold", () => {
    const theirs = mintFirstTenantKey().wrappedDek;
    useKeyring(KEY, "k2");
    expect(() => assertKeyringUnwraps([theirs])).toThrow(/ACTIVE root key/);
  });

  it("refuses a wrapped value that is not a DEK", () => {
    const notADek = encryptField(randomBytes(DEK_BYTES - 1).toString("base64"));
    expect(() => assertKeyringUnwraps([mintFirstTenantKey().wrappedDek, notADek])).toThrow(/#2/);
  });

  it("names a position, never the key material", () => {
    const theirs = mintFirstTenantKey().wrappedDek;
    useKeyring(OTHER_KEY);
    try {
      assertKeyringUnwraps([theirs]);
      expect.unreachable();
    } catch (e) {
      // The proof's own refusal — not `expect.unreachable`'s, which would
      // also land here and must not pass.
      expect(String(e)).toMatch(/does not unwrap the database's existing tenant key #1/);
      expect(String(e)).not.toContain(theirs);
      expect(String(e)).not.toContain(KEY);
    }
  });
});
