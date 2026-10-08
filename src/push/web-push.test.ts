import { createDecipheriv, createECDH, createPublicKey, generateKeyPairSync, hkdfSync, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MAX_PLAINTEXT_BYTES,
  PADDED_PLAINTEXT_BYTES,
  buildPushRequest,
  encryptPayload,
  receiverKeysOf,
  vapidAuthorization,
  vapidKeysOf,
  vapidPublicKeyText,
} from "./web-push";

const b64 = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ""), "base64url");

/** RFC 8291 §5 and Appendix A, copied from the RFC's text. */
const RFC8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** The receiver's side of RFC 8291, written out independently — what a browser does. */
function decryptAsBrowser(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  expect(rs).toBe(4096);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const secret = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  // The last record ends in 0x02 then zero padding.
  const end = padded.lastIndexOf(0x02);
  expect(padded.subarray(end + 1).every((b) => b === 0)).toBe(true);
  return padded.subarray(0, end).toString("utf8");
}

describe("RFC 8291 payload encryption", () => {
  it("reproduces the RFC's own example byte for byte (Appendix A)", () => {
    const receiver = receiverKeysOf(RFC8291.uaPublic, RFC8291.auth);
    expect(receiver).not.toBeNull();
    const body = encryptPayload(receiver!, Buffer.from(RFC8291.plaintext), {
      fixed: { salt: b64(RFC8291.salt), senderPrivateKey: b64(RFC8291.asPrivate) },
    });
    expect(body.toString("base64url")).toBe(RFC8291.body);
    // The header carries OUR public key (keyid), 86 octets in all.
    expect(body.subarray(21, 86).toString("base64url")).toBe(RFC8291.asPublic);
  });

  it("uses a fresh salt and ephemeral key every time, and the browser can read it", () => {
    const receiver = receiverKeysOf(RFC8291.uaPublic, RFC8291.auth)!;
    const a = encryptPayload(receiver, Buffer.from("same"));
    const b = encryptPayload(receiver, Buffer.from("same"));
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
    expect(decryptAsBrowser(a, b64(RFC8291.uaPrivate), b64(RFC8291.auth))).toBe("same");
  });

  it("refuses a payload one record cannot carry", () => {
    const receiver = receiverKeysOf(RFC8291.uaPublic, RFC8291.auth)!;
    expect(() => encryptPayload(receiver, Buffer.alloc(MAX_PLAINTEXT_BYTES + 1))).toThrow(/too large/);
    expect(() => encryptPayload(receiver, Buffer.alloc(MAX_PLAINTEXT_BYTES))).not.toThrow();
  });

  it("pads to a constant size with zero octets after the delimiter — and refuses to send a longer payload unpadded", () => {
    const receiver = receiverKeysOf(RFC8291.uaPublic, RFC8291.auth)!;
    const short = encryptPayload(receiver, Buffer.from("a"), { padTo: PADDED_PLAINTEXT_BYTES });
    const long = encryptPayload(receiver, Buffer.from("a".repeat(300)), { padTo: PADDED_PLAINTEXT_BYTES });
    expect(short.length).toBe(long.length);
    expect(decryptAsBrowser(short, b64(RFC8291.uaPrivate), b64(RFC8291.auth))).toBe("a");
    expect(() => encryptPayload(receiver, Buffer.alloc(PADDED_PLAINTEXT_BYTES + 1), { padTo: PADDED_PLAINTEXT_BYTES })).toThrow(/longer than the padded/);
  });
});

describe("receiverKeysOf — what a browser hands out", () => {
  it("accepts a real point and a 16-byte secret, with or without base64 padding", () => {
    expect(receiverKeysOf(RFC8291.uaPublic, RFC8291.auth)).not.toBeNull();
    expect(receiverKeysOf(RFC8291.uaPublic, `${RFC8291.auth}==`)).not.toBeNull();
  });

  it("refuses wrong lengths, a compressed point, a point off the curve and non-base64url", () => {
    const pub = b64(RFC8291.uaPublic);
    expect(receiverKeysOf(pub.subarray(0, 64).toString("base64url"), RFC8291.auth)).toBeNull();
    const compressed = Buffer.concat([Buffer.from([0x02]), pub.subarray(1, 33)]);
    expect(receiverKeysOf(compressed.toString("base64url"), RFC8291.auth)).toBeNull();
    const offCurve = Buffer.from(pub);
    offCurve[64] = offCurve[64]! ^ 0x01;
    expect(receiverKeysOf(offCurve.toString("base64url"), RFC8291.auth)).toBeNull();
    expect(receiverKeysOf(RFC8291.uaPublic, Buffer.alloc(15).toString("base64url"))).toBeNull();
    expect(receiverKeysOf(`${RFC8291.uaPublic}!`, RFC8291.auth)).toBeNull();
    expect(receiverKeysOf("", "")).toBeNull();
  });
});

/** A fresh VAPID pair in the env's form. */
function vapidPair(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  // 32 bytes exactly, as `scripts/generate-vapid-keys.ts` prints it.
  const scalar = ecdh.getPrivateKey();
  const privateKey = Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]);
  return { publicKey: ecdh.getPublicKey().toString("base64url"), privateKey: privateKey.toString("base64url") };
}

describe("RFC 8292 VAPID", () => {
  it("takes a pair that belongs together and refuses one that does not", () => {
    const a = vapidPair();
    const b = vapidPair();
    expect(vapidKeysOf(a.publicKey, a.privateKey, "mailto:ops@example.org")).not.toBeNull();
    expect(vapidKeysOf(a.publicKey, b.privateKey, "mailto:ops@example.org")).toBeNull();
    expect(vapidKeysOf(a.publicKey.slice(0, 20), a.privateKey, "mailto:ops@example.org")).toBeNull();
    expect(vapidKeysOf(a.publicKey, "", "mailto:ops@example.org")).toBeNull();
  });

  it("signs an ES256 JWT for the endpoint's ORIGIN that verifies with our public key", () => {
    const pair = vapidPair();
    const keys = vapidKeysOf(pair.publicKey, pair.privateKey, "mailto:ops@example.org")!;
    const now = new Date("2026-10-08T12:00:00Z");
    const header = vapidAuthorization(keys, new URL("https://fcm.googleapis.com/fcm/send/abc"), now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, s, k] = m!;
    expect(k).toBe(vapidPublicKeyText(keys));
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    expect(claims).toEqual({ aud: "https://fcm.googleapis.com", exp: now.getTime() / 1000 + 12 * 3600, sub: "mailto:ops@example.org" });
    const pub = createPublicKey({
      format: "jwk",
      key: { kty: "EC", crv: "P-256", x: b64(k!).subarray(1, 33).toString("base64url"), y: b64(k!).subarray(33).toString("base64url") },
    });
    const signature = Buffer.from(s!, "base64url");
    expect(signature.length).toBe(64);
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
    // Another key does not verify it.
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey;
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: other, dsaEncoding: "ieee-p1363" }, signature)).toBe(false);
  });

  it("builds the RFC 8030 request: aes128gcm body, the TTL it is given (whole seconds), normal urgency", () => {
    const pair = vapidPair();
    const keys = vapidKeysOf(pair.publicKey, pair.privateKey, "mailto:ops@example.org")!;
    const receiver = receiverKeysOf(RFC8291.uaPublic, RFC8291.auth)!;
    const req = buildPushRequest(keys, new URL("https://updates.push.services.mozilla.com/wpush/v2/x"), receiver, Buffer.from("{}"), {
      ttlSeconds: 840.7,
    });
    expect(req.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(req.headers["TTL"]).toBe("840");
    expect(req.headers["Urgency"]).toBe("normal");
    expect(req.headers["Authorization"]).toMatch(/^vapid t=/);
    expect(decryptAsBrowser(req.body, b64(RFC8291.uaPrivate), b64(RFC8291.auth))).toBe("{}");
  });
});
