import { cruxTransportKind } from "@/config";

import { fakeCrux } from "./fake";
import { liveCrux } from "./live";
import type { CruxTransport } from "./types";

/**
 * THE CHROME UX REPORT THIS PROCESS ASKS (Phase 6 slice 118; `src/config`'s
 * `cruxTransportKind`): Google itself, the deterministic fake, or none at all
 * — `off`, the default everywhere, under which no site is ever measured.
 */
export function cruxTransport(): CruxTransport | null {
  return cruxTransportKind === "live" ? liveCrux : cruxTransportKind === "fake" ? fakeCrux : null;
}

export { parseHistory } from "./parse";
export * from "./types";
