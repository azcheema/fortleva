import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto";

/**
 * THE WEB PUSH PROTOCOL, HAND-WRITTEN (Phase 5 slice 106; founder decision C74;
 * ARC-25 Stage B). Three RFCs, about a hundred lines over `node:crypto`, pinned
 * by the RFCs' own test vectors (`web-push.test.ts`):
 *
 *   - RFC 8291 — the payload is encrypted END TO END for the receiving browser
 *     (`aes128gcm`, one record): the push service carries bytes it cannot read.
 *   - RFC 8292 — VAPID: every request is signed with OUR key (an ES256 JWT for
 *     the push service's origin), and a subscription made against our public
 *     key accepts nothing signed by another.
 *   - RFC 8030 — the request itself: `TTL`, `Urgency`, POST to the endpoint.
 *
 * WHY NOT THE `web-push` PACKAGE. It brings its own HTTP client (and a proxy
 * agent) — the endpoint is a URL the member's BROWSER chose, so the request is
 * ours to shape: the allowlist, no redirects, a timeout, nothing read back
 * (`./send.ts`). The cryptography is small and the vectors pin it exactly.
 *
 * NOTHING HERE TOUCHES THE NETWORK OR THE DATABASE. It builds a request.
 */

const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const fromB64u = (s: string): Buffer => Buffer.from(s, "base64url");

/** RFC 8291 §4: one record of this size holds any payload we send. */
const RECORD_SIZE = 4096;
/** A P-256 public key, uncompressed (X9.62): 0x04 || x || y. */
const PUBLIC_KEY_BYTES = 65;
const PRIVATE_KEY_BYTES = 32;
const AUTH_SECRET_BYTES = 16;
const SALT_BYTES = 16;
const TAG_BYTES = 16;
/**
 * The most plaintext one record carries: the record size less the GCM tag and
 * the one-octet padding delimiter. Ours is a few hundred bytes by construction
 * (`./payload.ts`); a larger one is a bug, refused rather than split.
 */
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - TAG_BYTES - 1;

/**
 * EVERY PUSH IS THE SAME SIZE (the security review's low): the payload's
 * template is public (this repository), so without padding the ciphertext's
 * length would tell Apple, Google, Mozilla and Microsoft WHICH kind of event a
 * device received, and in which language. RFC 8291 pads with zero octets after
 * the 0x02 delimiter; every payload is padded to this many bytes before
 * encryption (`payload.test.ts` pins that each kind, in both languages, fits).
 */
export const PADDED_PLAINTEXT_BYTES = 512;

/** The browser's half of a subscription (`PushSubscription.toJSON().keys`), decoded. */
export type ReceiverKeys = {
  /** The browser's P-256 public key, uncompressed, 65 bytes. */
  readonly p256dh: Uint8Array;
  /** The browser's authentication secret, 16 bytes. */
  readonly auth: Uint8Array;
};

/**
 * Whether `p256dh` and `auth` are what a browser hands out: a 65-byte
 * uncompressed point that is ON the P-256 curve (an ECDH with it succeeds —
 * Node refuses a point off the curve) and a 16-byte secret. Checked when a
 * device is registered, so a row can never hold keys no push could use.
 */
export function receiverKeysOf(p256dh: string, auth: string): ReceiverKeys | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth)) return null;
  const pub = fromB64u(p256dh.replace(/=+$/, ""));
  const secret = fromB64u(auth.replace(/=+$/, ""));
  if (pub.length !== PUBLIC_KEY_BYTES || pub[0] !== 0x04 || secret.length !== AUTH_SECRET_BYTES) return null;
  try {
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(pub);
  } catch {
    return null;
  }
  return { p256dh: new Uint8Array(pub), auth: new Uint8Array(secret) };
}

/**
 * RFC 8291 §3.4: encrypt `plaintext` for the receiver. Returns the whole
 * `aes128gcm` body — header (salt, record size, our ephemeral public key) and
 * the one record, its plaintext padded with zero octets to `padTo` when given.
 *
 * `fixed` exists for the RFC's own test vector ONLY: a real push MUST use a
 * fresh salt and a fresh ephemeral key every time (§3.4 — reusing them across
 * messages to one receiver would reuse the GCM key and nonce).
 */
export function encryptPayload(
  receiver: ReceiverKeys,
  plaintext: Uint8Array,
  opts: {
    readonly padTo?: number;
    readonly fixed?: { readonly salt: Uint8Array; readonly senderPrivateKey: Uint8Array };
  } = {},
): Buffer {
  const { fixed } = opts;
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error("web push: payload too large for one record");
  const padTo = opts.padTo ?? plaintext.length;
  if (padTo > MAX_PLAINTEXT_BYTES) throw new Error("web push: padding past one record");
  // A payload longer than the constant size would give its kind away: refused, never sent unpadded.
  if (plaintext.length > padTo) throw new Error("web push: payload longer than the padded size");
  const sender = createECDH("prime256v1");
  if (fixed) sender.setPrivateKey(Buffer.from(fixed.senderPrivateKey));
  else sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const salt = fixed ? Buffer.from(fixed.salt) : randomBytes(SALT_BYTES);
  if (salt.length !== SALT_BYTES) throw new Error("web push: salt must be 16 bytes");

  const ecdhSecret = sender.computeSecret(Buffer.from(receiver.p256dh));
  // key_info = "WebPush: info" || 0x00 || ua_public || as_public
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), Buffer.from(receiver.p256dh), senderPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, Buffer.from(receiver.auth), keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12));

  // One record, the last: the plaintext, the 0x02 delimiter, then zero octets
  // up to the padded size.
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const padded = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02]), Buffer.alloc(padTo - plaintext.length)]);
  const record = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(SALT_BYTES + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES);
  header.writeUInt8(senderPublic.length, SALT_BYTES + 4);
  return Buffer.concat([header, senderPublic, record]);
}

/** Our VAPID key pair (RFC 8292), decoded and checked once (`src/config`). */
export type VapidKeys = {
  /** Uncompressed P-256 public key, 65 bytes — what browsers subscribe with. */
  readonly publicKey: Uint8Array;
  readonly privateKey: KeyObject;
  /** `mailto:` or `https:` — who to contact about our pushes (RFC 8292 §2.1). */
  readonly subject: string;
};

/**
 * The pair from its base64url halves, or null when they are not a P-256 pair
 * that belongs together (the private scalar must derive the public point).
 */
export function vapidKeysOf(publicKey: string, privateKey: string, subject: string): VapidKeys | null {
  const pub = fromB64u(publicKey);
  const priv = fromB64u(privateKey);
  if (pub.length !== PUBLIC_KEY_BYTES || pub[0] !== 0x04 || priv.length !== PRIVATE_KEY_BYTES) return null;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(priv);
    if (!ecdh.getPublicKey().equals(pub)) return null;
    const key = createPrivateKey({
      format: "jwk",
      key: { kty: "EC", crv: "P-256", d: b64u(priv), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    });
    return { publicKey: new Uint8Array(pub), privateKey: key, subject };
  } catch {
    return null;
  }
}

/** The public key as browsers take it for `applicationServerKey`. */
export const vapidPublicKeyText = (keys: VapidKeys): string => b64u(keys.publicKey);

/** How long a VAPID signature is good for — RFC 8292 caps it at 24 hours. */
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60;

/**
 * RFC 8292 §2–3: `Authorization: vapid t=<JWT>, k=<public key>` for one push
 * service. The JWT's audience is the ENDPOINT'S ORIGIN, so a signature made
 * for one push service is worth nothing at another.
 */
export function vapidAuthorization(keys: VapidKeys, endpoint: URL, now: Date = new Date()): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(
    Buffer.from(
      JSON.stringify({ aud: endpoint.origin, exp: Math.floor(now.getTime() / 1000) + VAPID_LIFETIME_SECONDS, sub: keys.subject }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  // ES256 in JOSE's form: r || s, 64 bytes — not DER.
  const signature = sign("sha256", Buffer.from(signingInput), { key: keys.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${signingInput}.${b64u(signature)}, k=${b64u(keys.publicKey)}`;
}

/** One push request, ready for the transport (`./send.ts`). */
export type PushRequest = {
  readonly endpoint: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
};

/**
 * RFC 8030 §5: the POST for one device. `ttlSeconds` is how long the push
 * service may hold it for a device that is offline — never into the member's
 * quiet time nor past the drain's window (`pushTtlSeconds`, `./verdict.ts`):
 * a "you were given a task" that arrives the next morning is noise, and the
 * inbox and the email carry it (C74 (c), (e)).
 */
export function buildPushRequest(
  keys: VapidKeys,
  endpoint: URL,
  receiver: ReceiverKeys,
  payload: Uint8Array,
  opts: { readonly ttlSeconds: number; readonly now?: Date },
): PushRequest {
  const ttl = Math.max(0, Math.floor(opts.ttlSeconds));
  return {
    endpoint,
    headers: {
      Authorization: vapidAuthorization(keys, endpoint, opts.now ?? new Date()),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "normal",
    },
    body: encryptPayload(receiver, payload, { padTo: PADDED_PLAINTEXT_BYTES }),
  };
}
