import type { CredentialType } from "@/modules/vault";

/**
 * What the Vault tab's client components are handed — a DIRECTIVE-FREE,
 * import-free module (a type import erases), because the vault module's
 * index reaches Prisma and must never be bundled for the browser. The
 * secret field NAMES per type come down from the page as a prop
 * (`fieldsByType`) for the same reason; no value ever does.
 */

export type VaultItem = {
  readonly id: string;
  readonly type: CredentialType;
  readonly name: string;
  readonly username: string | null;
  readonly url: string | null;
  readonly notes: string | null;
  readonly secretFieldKeys: readonly string[];
  readonly hasTotp: boolean;
  readonly needsRotation: boolean;
  /** The project it hangs on, or null for a client-level login. */
  readonly project: { readonly key: string; readonly name: string } | null;
};

export type FieldsByType = Readonly<Record<CredentialType, readonly string[]>>;

/** A secret that is text rather than a string: shown wrapped, typed in a textarea. */
export const isMultilineSecret = (key: string): boolean => key === "note" || key === "privateKey";

/**
 * Every secret field name any type has (`SECRET_FIELDS` in the vault
 * module, which this module may not import) — so a label can be looked up
 * by a TYPED key. `vault-shape.test.ts` holds the two lists together.
 */
export const SECRET_FIELD_KEYS = [
  "password",
  "note",
  "apiKey",
  "apiSecret",
  "privateKey",
  "passphrase",
  "connectionString",
  "licenseKey",
  "secret",
] as const;
export type SecretFieldKey = (typeof SECRET_FIELD_KEYS)[number];

/** A field name from the server as its label key; an unknown one reads as "Secret". */
export const fieldLabelKey = (key: string): `fields.${SecretFieldKey}` =>
  `fields.${(SECRET_FIELD_KEYS as readonly string[]).includes(key) ? (key as SecretFieldKey) : "secret"}`;
