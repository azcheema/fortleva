import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

import { STATE_SEED_KEYS, type StateSeedKey } from "./enum-map";

/**
 * The seeded stage labels, pinned against the REAL catalogues.
 *
 * This slice deleted `DEFAULT_STATE_NAMES` from src/modules/work/states.ts
 * — the table that used to write these words into the database at
 * seeding time. The words did not stop mattering when they stopped
 * being stored: a Swedish tenant seeded before 2026-09-01 has "Pågår"
 * in its rows, and a project seeded after renders through i18n instead.
 * If the Swedish catalogue drifts, those two projects show different
 * words for the same state, side by side, and nothing else would catch
 * it — the messages are consumed only through `t(seedKey)`.
 *
 * So this asserts the exact strings the deleted table wrote. Changing
 * one is a deliberate act that has to come here first.
 */

const SEEDED_BY_THE_OLD_TABLE: Record<"en" | "sv", Record<StateSeedKey, string>> = {
  en: {
    BACKLOG: "Backlog",
    TODO: "To do",
    IN_PROGRESS: "In progress",
    IN_REVIEW: "In review",
    DONE: "Done",
    CANCELLED: "Cancelled",
    TRIAGE: "Triage",
  },
  sv: {
    BACKLOG: "Backlogg",
    TODO: "Att göra",
    IN_PROGRESS: "Pågår",
    IN_REVIEW: "Granskning",
    DONE: "Klar",
    CANCELLED: "Avbruten",
    TRIAGE: "Triage",
  },
};

const seedMessages = (catalogue: typeof en | typeof sv): Record<string, string> =>
  (catalogue as { projects: { states: { seed: Record<string, string> } } }).projects.states.seed;

describe("projects.states.seed", () => {
  it.each(["en", "sv"] as const)("%s carries exactly the seven seed keys", (locale) => {
    const messages = seedMessages(locale === "en" ? en : sv);
    expect(Object.keys(messages).sort()).toEqual([...STATE_SEED_KEYS].sort());
  });

  it.each(["en", "sv"] as const)(
    "%s still reads exactly what the old seed table wrote into the database",
    (locale) => {
      const messages = seedMessages(locale === "en" ? en : sv);
      for (const key of STATE_SEED_KEYS) {
        expect(messages[key]).toBe(SEEDED_BY_THE_OLD_TABLE[locale][key]);
      }
    },
  );

  it("never renders a label that is its own key — the raw-enum-on-screen failure", () => {
    for (const catalogue of [en, sv]) {
      const messages = seedMessages(catalogue);
      for (const key of STATE_SEED_KEYS) {
        expect(messages[key]).toBeTruthy();
        expect(messages[key]).not.toBe(key);
      }
    }
  });

  it("does NOT reuse the stateCategory catalogue, which is a different axis", () => {
    // Six categories, seven seed keys, and the Swedish differs
    // ("Klart"/"Avbrutet" vs "Klar"/"Avbruten"). Reusing it would
    // silently change what every Swedish tenant reads.
    const categories = (sv as { states: { stateCategory: Record<string, string> } }).states
      .stateCategory;
    expect(Object.keys(categories)).not.toContain("IN_REVIEW");
    expect(seedMessages(sv)["DONE"]).not.toBe(categories["DONE"]);
  });
});
