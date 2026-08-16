import { r2Config } from "@/config";

import { LocalDiskTransport } from "./local";
import { R2Transport } from "./r2";
import type { StorageTransport } from "./transport";

export type {
  StorageTransport,
  PresignPutOptions,
  PresignedPut,
  PresignGetOptions,
  HeadResult,
} from "./transport";
export { assertStorageKey } from "./transport";
export { LocalDiskTransport } from "./local";
export { R2Transport } from "./r2";

let instance: StorageTransport | null = null;

/**
 * The one storage instance: R2 when the four R2_* env vars are set,
 * else the local-disk dev transport (which refuses production).
 * Logged once so a misconfigured deploy is loud, not silent.
 */
export function getStorage(): StorageTransport {
  if (instance) return instance;
  if (r2Config) {
    instance = new R2Transport(r2Config);
    console.log(`[storage] R2 transport (bucket=${r2Config.bucket}, endpoint=${r2Config.endpoint})`);
  } else {
    instance = new LocalDiskTransport();
    console.log("[storage] local-disk dev transport (.dev-storage/) — set R2_* env vars for R2");
  }
  return instance;
}

/** Test seam: swap the transport (e.g. a LocalDiskTransport in a temp dir). */
export function setStorage(transport: StorageTransport | null): void {
  instance = transport;
}
