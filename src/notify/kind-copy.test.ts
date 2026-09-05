import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

import { NOTIFICATION_KINDS, type NotificationKind } from "./catalog";
import { ALL_KIND_COPY_KEYS, GENERIC_COPY_KEY, KIND_MESSAGE_KEY } from "./kind-copy";

/**
 * The inbox's kind labels, coupled to the kind CATALOG.
 *
 * What this adds over `src/i18n/messages.test.ts` — which already pins
 * en/sv key parity and refuses an empty value — is the one thing a
 * catalogue-only test cannot see: whether the labels and the kinds
 * still describe each other. Copy missing from BOTH catalogues, and a
 * label left behind by a kind that was removed, are both invisible to
 * parity and both reach a member as a raw message key.
 *
 * The `k as NotificationKind` route through `NOTIFICATION_KINDS` is
 * deliberate here and nowhere else: `Record<NotificationKind, …>` makes
 * the map's coverage a compile-time fact, and this file is the runtime
 * backstop for it, because vitest transpiles without typechecking.
 *
 * Same argument as `src/lib/state-seed-messages.test.ts`: words
 * consumed only through `t()` need a test that reads the catalogue.
 */

const kindCopy = (messages: typeof en | typeof sv): Record<string, unknown> =>
  (messages as unknown as { inbox: { kind: Record<string, unknown> } }).inbox.kind;

describe("inbox kind labels", () => {
  it("every catalogued kind has a copy key", () => {
    for (const kind of Object.keys(NOTIFICATION_KINDS) as NotificationKind[]) {
      expect(KIND_MESSAGE_KEY[kind], kind).toBeTruthy();
    }
  });

  it.each([
    ["en", en],
    ["sv", sv],
  ])("%s labels every kind, and the unknown-kind fallback", (_locale, messages) => {
    const copy = kindCopy(messages);
    for (const key of ALL_KIND_COPY_KEYS) {
      expect(typeof copy[key], key).toBe("string");
    }
  });

  it("carries no label the inbox can never ask for", () => {
    // A leftover key is a kind that was removed without its copy, which
    // is how a catalogue drifts out of step with the code that reads it.
    // `ALL_KIND_COPY_KEYS` is deduplicated, so two kinds sharing one
    // label is not mistaken for a leftover.
    expect(Object.keys(kindCopy(en)).sort()).toEqual([...ALL_KIND_COPY_KEYS].sort());
  });

  it("the fallback key is distinct from every kind's", () => {
    expect(Object.values(KIND_MESSAGE_KEY)).not.toContain(GENERIC_COPY_KEY);
  });
});
