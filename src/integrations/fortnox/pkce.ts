import { createHash, randomBytes } from "node:crypto";

/**
 * A connect attempt's secrets (Phase 4 slice 114; the design's §4.3, §10.6):
 * the OAuth `state` — 32 random bytes, base64url; stored only as its SHA-256
 * (`stateHashOf`) — and the PKCE verifier (RFC 7636: 32 random bytes,
 * base64url = 43 characters) with its S256 challenge.
 */

const b64u = (bytes: Buffer): string => bytes.toString("base64url");

export const newState = (): string => b64u(randomBytes(32));

export const newPkceVerifier = (): string => b64u(randomBytes(32));

/** S256: BASE64URL(SHA-256(ASCII(verifier))). */
export const codeChallengeOf = (verifier: string): string => b64u(createHash("sha256").update(verifier, "ascii").digest());

/** What the attempt row stores of the state: its SHA-256, hex. */
export const stateHashOf = (state: string): string => createHash("sha256").update(state, "utf8").digest("hex");

/** A `state` as we mint them — anything else is never looked up. */
export const isStateShape = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
