// generate-vapid-keys — A NEW KEY PAIR FOR PHONE AND BROWSER NOTIFICATIONS
// (Phase 5 slice 106, founder decision C74; RUNBOOK §1).
//
//   pnpm exec tsx scripts/generate-vapid-keys.ts
//
// Prints two environment lines: WEB_PUSH_VAPID_PUBLIC_KEY and
// WEB_PUSH_VAPID_PRIVATE_KEY (RFC 8292 — a P-256 pair, base64url). Put them in
// the environment of ONE deployment; every environment gets its own pair. Every
// browser that turns notifications on subscribes against the public key and
// from then on accepts only pushes signed with the private one — so REPLACING
// the pair silently ends every device's notifications (each person turns them
// on again in Settings → Notifications). Generate once per environment, keep
// the private key with the other secrets, never in the repository.
//
// It touches no database and no network, and prints nothing else.
import { createECDH } from "node:crypto";

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
// The scalar as exactly 32 bytes: a key with a leading zero byte must not come
// out one byte short (`src/config` refuses anything but 32).
const scalar = ecdh.getPrivateKey();
const privateKey = Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]);
process.stdout.write(
  `WEB_PUSH_VAPID_PUBLIC_KEY=${ecdh.getPublicKey().toString("base64url")}\n` +
    `WEB_PUSH_VAPID_PRIVATE_KEY=${privateKey.toString("base64url")}\n`,
);
