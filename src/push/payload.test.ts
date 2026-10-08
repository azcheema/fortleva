import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { NOTIFICATION_KINDS, type NotificationKind } from "@/notify/catalog";
import { KIND_MESSAGE_KEY } from "@/notify/kind-copy";
import { isWorkMail } from "@/notify/work-mail";

import { PUSH_KINDS, encodePushPayload, isPushKind, pushOpenPath, pushPayload } from "./payload";
import { PADDED_PLAINTEXT_BYTES } from "./web-push";

const ID = "0199c2a0-1234-7abc-8def-0123456789ab";

describe("which kinds push (C74: the ones that may email, and the owners' alarm — (i))", () => {
  it("is every kind the work mail sends, plus the logins alarm, and nothing else", () => {
    for (const kind of Object.keys(NOTIFICATION_KINDS) as NotificationKind[]) {
      // The work mail's set — the drain's and the email's choices cannot drift.
      expect(isPushKind(kind), kind).toBe(isWorkMail(kind) || kind === "contact.logins_alarm");
      if (isPushKind(kind)) expect(NOTIFICATION_KINDS[kind].class, kind).toBe("INSTANT");
    }
    expect(isPushKind("contact.logins_alarm")).toBe(true);
    expect(PUSH_KINDS.length).toBeGreaterThan(0);
    expect(isPushKind("work_item.commented")).toBe(false);
    expect(isPushKind("no.such_kind")).toBe(false);
    expect(isPushKind("__proto__")).toBe(false);
  });
});

describe("what a push says (C74 (a): what happened, never a name)", () => {
  it("is the inbox's own line for the kind, in the member's language, with no slot a name could fill", () => {
    for (const kind of PUSH_KINDS) {
      const key = KIND_MESSAGE_KEY[kind];
      for (const [locale, messages] of [
        ["en", en],
        ["sv", sv],
      ] as const) {
        const payload = pushPayload(ID, kind, locale);
        expect(payload.body).toBe(messages.inbox.kind[key]);
        expect(payload.body.length).toBeGreaterThan(0);
        // No ICU argument: a line with `{…}` would be filled with SOMETHING.
        expect(payload.body, `${locale} ${kind}`).not.toMatch(/[{}]/);
        expect(payload.title).toBe("Fortleva");
      }
    }
  });

  it("falls back to English and to the generic line, never to a raw key", () => {
    expect(pushPayload(ID, "work_item.assigned", "de").body).toBe(en.inbox.kind.assigned);
    expect(pushPayload(ID, "no.such_kind", "sv").body).toBe(sv.inbox.kind.generic);
  });

  it("opens /inbox/open/<id> and carries the id, and nothing else", () => {
    const payload = pushPayload(ID, "comment.mentioned", "en");
    expect(payload).toEqual({ v: 1, id: ID, title: "Fortleva", body: en.inbox.kind.mentioned, url: pushOpenPath(ID) });
    expect(payload.url).toBe(`/inbox/open/${ID}`);
  });

  it("fits the constant padded size in either language, so every push is the same length on the wire", () => {
    for (const kind of PUSH_KINDS) {
      for (const locale of ["en", "sv"]) {
        expect(encodePushPayload(pushPayload(ID, kind, locale)).length, `${locale} ${kind}`).toBeLessThanOrEqual(PADDED_PLAINTEXT_BYTES);
      }
    }
  });
});
