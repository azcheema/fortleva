import { randomBytes } from "node:crypto";

/**
 * RFC 9562 UUIDv7 generator (48-bit unix-ms timestamp, 12-bit
 * monotonic sequence, 62 random bits). Services call this to know a
 * row id BEFORE insert — the id is part of the AAD of any v2-encrypted
 * field on that row (src/crypto/field-encryption.ts). Same layout as
 * Prisma's @default(uuid(7)) so ids sort by creation time either way.
 */

let lastMs = 0;
let seq = 0;

export function newId(): string {
  let ms = Date.now();
  if (ms <= lastMs) {
    ms = lastMs;
    seq = (seq + 1) & 0xfff;
    if (seq === 0) ms = ++lastMs; // 4096 ids in one ms: borrow the next
  } else {
    seq = randomBytes(2).readUInt16BE(0) & 0x7ff; // random start, room to grow
  }
  lastMs = ms;

  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | (seq >> 8); // version 7 + seq high nibble
  b[7] = seq & 0xff;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
