import { describe, expect, it } from "vitest";

import { STATE_SEED_KEYS, type StateSeedKey } from "./enum-map";
import { stateLabel } from "./state-label";

/**
 * The translate-until-renamed rule (DATA_MODEL §6.14). The interesting
 * cases are not "does it call t()" — they are the two ways this could
 * quietly break the safety-critical half of the feature: a tenant's own
 * words getting translated away, and a seed key leaking to screen as a
 * raw enum.
 */

const t = (key: StateSeedKey): string => `translated:${key}`;

describe("stateLabel", () => {
  it("renders a seeded state through i18n — this is the whole feature", () => {
    expect(stateLabel({ name: null, seedKey: "IN_REVIEW" }, t)).toBe("translated:IN_REVIEW");
  });

  it("renders tenant text VERBATIM and never translates it", () => {
    expect(stateLabel({ name: "Granskning", seedKey: "IN_REVIEW" }, t)).toBe("Granskning");
  });

  it("keeps tenant text even when the tenant renamed a state to its own seed's English label", () => {
    // naxdor did exactly this on 2026-08-31: renamed the Swedish seeds
    // to the English words. Those rows carry a name, so they are tenant
    // text — a viewer's locale must NOT move them back to Swedish.
    expect(stateLabel({ name: "In review", seedKey: "IN_REVIEW" }, t)).toBe("In review");
  });

  it("treats the empty string as a name, not as absent", () => {
    // `?? ` / falsy checks would send this to the translator and show a
    // seeded label for a state the tenant deliberately blanked.
    expect(stateLabel({ name: "", seedKey: "DONE" }, t)).toBe("");
  });

  it("renders a tenant-created state (no seed key) by its name", () => {
    expect(stateLabel({ name: "Waiting on client", seedKey: null }, t)).toBe("Waiting on client");
  });

  it("never leaks a raw seed key to screen for any of the seven", () => {
    for (const key of STATE_SEED_KEYS) {
      const label = stateLabel({ name: null, seedKey: key }, (k) => `«${k}»`);
      expect(label).toBe(`«${key}»`);
      expect(label).not.toBe(key);
    }
  });

  it("falls back to empty rather than throwing on the row the CHECK forbids", () => {
    // workflow_state_name_or_seed_key makes this unreachable; the guard
    // exists so a future column change cannot crash a render.
    expect(stateLabel({ name: null, seedKey: null }, t)).toBe("");
  });
});
