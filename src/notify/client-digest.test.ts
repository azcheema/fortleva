import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CLIENT_DIGEST_COUNTS,
  CONTACT_DIGEST_MAIL,
  clientDigestHasNews,
  contactDigestKey,
  readClientDigestCounts,
  renderContactDigest,
} from "./client-digest";
import { clientSummaryToken, readClientSummaryToken } from "./client-summary-token";

/**
 * THE CLIENTS' WEEKLY SUMMARY EMAIL, its pure half (Phase 5 slice 101;
 * founder decision C69): what one says, and the link that stops it.
 */

const LINKS = { portal: "https://app.example/portal", unsubscribe: "https://app.example/portal/unsubscribe/T" };
const NONE = { updates: 0, replies: 0, files: 0, signoffs: 0, tasks: 0, logins: 0 };

describe("readClientDigestCounts", () => {
  it("keeps only known keys with positive whole numbers", () => {
    expect(
      readClientDigestCounts({ updates: 2, replies: -1, files: 1.5, signoffs: "3", tasks: 1, logins: 0, other: 9 }),
    ).toEqual({ ...NONE, updates: 2, tasks: 1 });
  });

  it("answers all zeros for anything that is not an object", () => {
    for (const raw of [null, undefined, 3, "x", [1, 2]]) expect(readClientDigestCounts(raw)).toEqual(NONE);
  });
});

describe("clientDigestHasNews", () => {
  it("is false with nothing new and nothing waiting", () => {
    expect(clientDigestHasNews(NONE)).toBe(false);
  });

  it("is true for something WAITING alone (C69 (c))", () => {
    expect(clientDigestHasNews({ ...NONE, signoffs: 1 })).toBe(true);
    expect(clientDigestHasNews({ ...NONE, logins: 1 })).toBe(true);
  });
});

describe("renderContactDigest", () => {
  it("is null when there is nothing to say", () => {
    expect(renderContactDigest("en", NONE, LINKS)).toBeNull();
    expect(renderContactDigest("sv", { junk: 4 }, LINKS)).toBeNull();
  });

  it("says what is new and what is waiting, each under its own heading, with both links", () => {
    const mail = renderContactDigest("en", { updates: 1, replies: 3, signoffs: 2 }, LINKS)!;
    expect(mail.subject).toBe("Your weekly summary from your agency");
    expect(mail.text).toContain("New since your last summary:\n- 1 new update from your agency\n- Your agency replied on 3 tasks");
    expect(mail.text).toContain("Waiting for you:\n- 2 things are waiting for your sign-off");
    expect(mail.text).toContain(LINKS.portal);
    expect(mail.text).toContain(LINKS.unsubscribe);
  });

  it("leaves out a heading with nothing under it", () => {
    const waitingOnly = renderContactDigest("en", { tasks: 1 }, LINKS)!;
    expect(waitingOnly.text).not.toContain("New since your last summary");
    expect(waitingOnly.text).toContain("- 1 task is waiting for you");
    const newOnly = renderContactDigest("en", { files: 2 }, LINKS)!;
    expect(newOnly.text).not.toContain("Waiting for you");
  });

  it("writes Swedish for a Swedish reader", () => {
    const mail = renderContactDigest("sv", { updates: 2, logins: 1 }, LINKS)!;
    expect(mail.subject).toBe("Din veckosammanfattning från din byrå");
    expect(mail.text).toContain("- 2 nya uppdateringar från din byrå");
    expect(mail.text).toContain("Väntar på dig:\n- Din byrå har bett dig om 1 inloggning");
  });

  it("has a line in both languages for every count", () => {
    for (const key of CLIENT_DIGEST_COUNTS) {
      for (const locale of ["en", "sv"]) {
        for (const n of [1, 4]) {
          const mail = renderContactDigest(locale, { [key]: n }, LINKS)!;
          expect(mail, `${locale} ${key} ${n}`).not.toBeNull();
          expect(mail.text).toContain(n === 1 ? "1" : "4");
        }
      }
    }
  });
});

describe("contactDigestKey", () => {
  it("is one per person per ISO week, and cannot collide with a member's", () => {
    expect(contactDigestKey("c1", "2026-W41")).toBe("digest:contact:c1:2026-W41");
    expect(CONTACT_DIGEST_MAIL).toBe("digest.contact");
  });
});

describe("the unsubscribe link's token", () => {
  const tenantId = "0199b1a2-0000-7000-8000-000000000001";
  const contactId = "0199b1a2-0000-7000-8000-000000000002";

  it("round-trips to the same two ids", () => {
    expect(readClientSummaryToken(clientSummaryToken(tenantId, contactId))).toEqual({ tenantId, contactId });
  });

  it("is the same token every week (stateless: old mails' links keep working)", () => {
    expect(clientSummaryToken(tenantId, contactId)).toBe(clientSummaryToken(tenantId, contactId));
  });

  it("refuses a token whose ids were swapped or edited", () => {
    const token = clientSummaryToken(tenantId, contactId);
    const mac = token.slice(74);
    expect(readClientSummaryToken(`${contactId}.${tenantId}.${mac}`)).toBeNull();
    const other = "0199b1a2-0000-7000-8000-000000000003";
    expect(readClientSummaryToken(`${tenantId}.${other}.${mac}`)).toBeNull();
  });

  it("refuses an edited mac, including another spelling of the same bytes", () => {
    const token = clientSummaryToken(tenantId, contactId);
    const last = token.at(-1)!;
    // Flip the last character to its neighbour: the same leading bits may
    // decode to the same bytes, but one link has one spelling.
    const swapped = token.slice(0, -1) + (last === "A" ? "B" : "A");
    expect(readClientSummaryToken(swapped)).toBeNull();
  });

  it("refuses every malformed shape without throwing", () => {
    const token = clientSummaryToken(tenantId, contactId);
    for (const raw of [null, 7, "", token.slice(1), `${token}x`, token.replace(".", "-"), token.toUpperCase()]) {
      expect(readClientSummaryToken(raw)).toBeNull();
    }
  });

  it("will not mint a link for something that is not an id", () => {
    expect(() => clientSummaryToken("acme", contactId)).toThrow();
    expect(() => clientSummaryToken(tenantId, "")).toThrow();
  });
});

describe("nobody at the agency can start a person's summary again (C69)", () => {
  // The rule is the application's, not the database's: `notification_preference`
  // is class A, so any tenant-principal code COULD write a CONTACT row (the
  // security review's low, recorded in SECURITY.md). This pins the writers: the
  // stop link's service, the contact delete (which only removes), and the
  // member's own settings — which may never name a CONTACT row.
  const SRC = join(__dirname, "..");
  const WRITE = /notificationPreference\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/;
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === "generated" || entry === "node_modules") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry) && !/\.(test|dbtest)\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  };

  it("only three files write a notification preference, and the member's own never a CONTACT row", () => {
    const writers = walk(SRC)
      .filter((f) => WRITE.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f).split(sep).join("/"))
      .sort();
    expect(writers).toEqual(["clients/service.ts", "notify/client-summary.ts", "notify/preferences.ts"]);
    expect(readFileSync(join(SRC, "notify", "preferences.ts"), "utf8")).not.toMatch(/"CONTACT"/);
  });
});
