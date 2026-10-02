import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
// The pure file, not the index: the index reaches the database client, and
// a test is outside the boundary rule (`vault-boundary.test.ts`).
import { SECRET_FIELDS } from "@/modules/vault/fields";

import { fieldLabelKey, SECRET_FIELD_KEYS } from "./vault-shape";

describe("the Vault tab's field names", () => {
  it("are exactly the vault module's secret fields, each with a label in both languages", () => {
    const fromModule = [...new Set(Object.values(SECRET_FIELDS).flat())].sort();
    expect([...SECRET_FIELD_KEYS].sort()).toEqual(fromModule);
    for (const key of SECRET_FIELD_KEYS) {
      expect(en.vault.fields[key], `en ${key}`).toBeTruthy();
      expect(sv.vault.fields[key], `sv ${key}`).toBeTruthy();
    }
  });

  it("an unknown field name reads as a generic secret, never as a missing key", () => {
    expect(fieldLabelKey("password")).toBe("fields.password");
    expect(fieldLabelKey("__proto__")).toBe("fields.secret");
  });
});
