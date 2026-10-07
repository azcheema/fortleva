import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { drainOutbox } from "@/jobs/outbox";
import { DomainError } from "@/lib/domain-error";
import { setTransport, type MailMessage, type MailTransport } from "@/mailer";
import { noMfa, setupTenant } from "@/members/dbtest-fixture";
import { createInvite } from "@/members/invites";
import { resetLocalLimiter } from "@/ratelimit";

import {
  REPLY_TO_KEY,
  REPLY_TO_PENDING_KEY,
  cancelReplyAddressRequest,
  confirmReplyAddress,
  readReplyAddressLink,
  readReplyAddressSettings,
  removeReplyAddress,
  requestReplyAddressAndMail,
  resolveReplyAddress,
} from "./reply-address";
import { REPLY_ADDRESS_CHANGED_MAIL } from "./reply-address-mail-key";

/**
 * THE WORKSPACE'S REPLY ADDRESS against the real database (Phase 5 slice 100;
 * founder decision C68 (c), (f), (i)): who may ask, what a link can and cannot
 * do, what the owners are told, and which mail carries the address. Every
 * drain is held to this tenant (`drainOutbox(…, { tenantId })`).
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let restoreTransport: MailTransport | null = null;
const sent: (MailMessage & { from: string })[] = [];
let ownerEmail: string;

beforeAll(async () => {
  f = await setupTenant("replyto");
  restoreTransport = setTransport(async (msg) => {
    sent.push(msg);
  });
  ownerEmail = (await f.platform.user.findUniqueOrThrow({ where: { id: f.seats.owner.userId } })).email.toLowerCase();
}, 60_000);

afterAll(async () => {
  if (restoreTransport) setTransport(restoreTransport);
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 60_000);

beforeEach(async () => {
  sent.length = 0;
  resetLocalLimiter();
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({
    where: { tenantId: f.tenantId, key: { in: [REPLY_TO_KEY, REPLY_TO_PENDING_KEY] } },
  });
  await f.platform.member.updateMany({ where: { tenantId: f.tenantId }, data: { status: "ACTIVE" } });
});

const ctxOf = (seat: "owner" | "admin" | "manager" | "employee") => ({
  tenantId: f.tenantId,
  actor: f.seats[seat].actor,
});

/** The token from the last confirmation mail — the only place it exists. */
const lastToken = (): string => {
  const mail = sent.at(-1);
  const match = mail?.text.match(/\/reply-address\/([^\s]+)/);
  if (!match) throw new Error("no confirmation link was mailed");
  return match[1]!;
};

const resolve = () => withTenant(f.tenantId, { type: "system" }, (tx) => resolveReplyAddress(tx, f.tenantId));

const domainCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

describe("asking for a reply address", () => {
  it("replies go to the owner until one is confirmed", async () => {
    expect(await resolve()).toBe(ownerEmail);
    const settings = await readReplyAddressSettings(ctxOf("manager"));
    expect(settings).toEqual({ confirmed: null, pending: null, ownerEmail });
  });

  it("needs settings:edit — an employee, or a manager, is refused", async () => {
    await expect(requestReplyAddressAndMail(ctxOf("employee"), "hello@agency.example")).rejects.toBeInstanceOf(AuthzError);
    await expect(requestReplyAddressAndMail(ctxOf("manager"), "hello@agency.example")).rejects.toBeInstanceOf(AuthzError);
    expect(sent).toHaveLength(0);
  });

  it("needs a FRESH second factor (C68 (k)) — an admin's open session alone is not enough", async () => {
    const stale = { tenantId: f.tenantId, actor: noMfa(f.seats.admin.memberId) };
    const refused = await requestReplyAddressAndMail(stale, "hello@agency.example").then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(AuthzError);
    expect((refused as AuthzError).reason).toBe("MFA_REQUIRED");
    expect(sent).toHaveLength(0);
    expect(
      await f.platform.tenantPreference.count({ where: { tenantId: f.tenantId, key: REPLY_TO_PENDING_KEY } }),
    ).toBe(0);
  });

  it("mails a link to the NEW address and changes nothing else — the secret is stored only as a hash", async () => {
    const made = await requestReplyAddressAndMail(ctxOf("admin"), "  Hello@Agency.Example ");
    expect(made.email).toBe("hello@agency.example");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("hello@agency.example");
    expect(sent[0]!.replyTo).toBeUndefined();
    // The mail names nothing a member typed.
    expect(sent[0]!.text).not.toContain("replyto");
    const token = lastToken();
    expect(await resolve()).toBe(ownerEmail);

    const row = await f.platform.tenantPreference.findFirstOrThrow({
      where: { tenantId: f.tenantId, key: REPLY_TO_PENDING_KEY },
    });
    const stored = JSON.stringify(row.value);
    expect(stored).not.toContain(token.split(".")[1]);
    expect(stored).toContain("hello@agency.example");

    const settings = await readReplyAddressSettings(ctxOf("manager"));
    expect(settings.pending?.email).toBe("hello@agency.example");
    expect(JSON.stringify(settings)).not.toContain("tokenHash");

    const [event] = await f.audits("reply_address.requested").then((e) => e.slice(-1));
    expect(event!.actorId).toBe(f.seats.admin.memberId);
    expect(event!.metadata).toMatchObject({ email: "hello@agency.example", replacedPending: false });
  });

  it("refuses what cannot receive a reply, the address already in use, and one that bounced", async () => {
    expect(await domainCode(requestReplyAddressAndMail(ctxOf("owner"), "not an address"))).toBe("REPLY_ADDRESS_INVALID");
    const sending = (process.env["MAIL_FROM_ADDRESS"] ?? "dev@localhost.invalid").split("@")[1]!;
    expect(await domainCode(requestReplyAddressAndMail(ctxOf("owner"), `someone@${sending}`))).toBe(
      "REPLY_ADDRESS_INVALID",
    );

    await requestReplyAddressAndMail(ctxOf("owner"), "office@agency.example");
    expect(await confirmReplyAddress(lastToken())).toBe("confirmed");
    expect(await domainCode(requestReplyAddressAndMail(ctxOf("owner"), "office@agency.example"))).toBe(
      "REPLY_ADDRESS_UNCHANGED",
    );

    await f.platform.emailSuppression.create({
      data: { email: "bounced-replyto@agency.example", reason: "HARD_BOUNCE", source: "dbtest" },
    });
    try {
      expect(await domainCode(requestReplyAddressAndMail(ctxOf("owner"), "bounced-replyto@agency.example"))).toBe(
        "REPLY_ADDRESS_UNDELIVERABLE",
      );
    } finally {
      await f.platform.emailSuppression.delete({ where: { email: "bounced-replyto@agency.example" } });
    }
  });

  it("is limited: five mails a day per workspace, three a day to one address", async () => {
    for (let i = 0; i < 3; i += 1) await requestReplyAddressAndMail(ctxOf("owner"), "same@agency.example");
    expect(await domainCode(requestReplyAddressAndMail(ctxOf("owner"), "same@agency.example"))).toBe(
      "REPLY_ADDRESS_LIMIT",
    );
    resetLocalLimiter();
    for (let i = 0; i < 5; i += 1) await requestReplyAddressAndMail(ctxOf("owner"), `n${i}@agency.example`);
    expect(await domainCode(requestReplyAddressAndMail(ctxOf("owner"), "n5@agency.example"))).toBe(
      "REPLY_ADDRESS_LIMIT",
    );
  });

  it("removes the waiting row again when the mail cannot be sent", async () => {
    const real = setTransport(async () => {
      throw new Error("transport down");
    });
    try {
      expect(await domainCode(requestReplyAddressAndMail(ctxOf("owner"), "down@agency.example"))).toBe(
        "REPLY_ADDRESS_MAIL_FAILED",
      );
    } finally {
      setTransport(real);
    }
    expect(
      await f.platform.tenantPreference.count({ where: { tenantId: f.tenantId, key: REPLY_TO_PENDING_KEY } }),
    ).toBe(0);
    // …and the trail says so: no request is left waiting forever in it.
    expect((await f.audits("reply_address.request_cancelled")).at(-1)?.metadata).toMatchObject({
      email: "down@agency.example",
      reason: "mail_failed",
    });
  });
});

describe("the link", () => {
  it("opens to the address and the workspace, changes nothing when read, and confirms once", async () => {
    await requestReplyAddressAndMail(ctxOf("admin"), "hello@agency.example");
    const token = lastToken();
    const link = await readReplyAddressLink(token);
    expect(link?.email).toBe("hello@agency.example");
    expect(link?.workspaceName).toMatch(/^replyto /);
    expect(await resolve()).toBe(ownerEmail);

    expect(await confirmReplyAddress(token)).toBe("confirmed");
    expect(await resolve()).toBe("hello@agency.example");
    expect(await confirmReplyAddress(token)).toBe("dead");
    expect(await readReplyAddressLink(token)).toBeNull();

    const settings = await readReplyAddressSettings(ctxOf("manager"));
    expect(settings.confirmed?.email).toBe("hello@agency.example");
    expect(settings.pending).toBeNull();

    const [event] = await f.audits("reply_address.confirmed").then((e) => e.slice(-1));
    expect(event!.actorType).toBe("SYSTEM");
    expect(event!.metadata).toMatchObject({ email: "hello@agency.example", requestedByMemberId: f.seats.admin.memberId });
  });

  it("tells every OWNER — a notice whatever their email level, that carries no Reply-To", async () => {
    await f.platform.notificationPreference.create({
      data: { tenantId: f.tenantId, receiverType: "MEMBER", receiverId: f.seats.owner.memberId, emailLevel: "NONE" },
    });
    try {
      await requestReplyAddressAndMail(ctxOf("admin"), "hello@agency.example");
      expect(await confirmReplyAddress(lastToken())).toBe("confirmed");
      const notices = await f.platform.emailOutbox.findMany({
        where: { tenantId: f.tenantId, kind: REPLY_ADDRESS_CHANGED_MAIL },
      });
      expect(notices.map((n) => n.receiverId)).toEqual([f.seats.owner.memberId]);
      expect(notices[0]!.params).toBeNull();

      sent.length = 0;
      await drainOutbox(50, { tenantId: f.tenantId });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe(ownerEmail);
      expect(sent[0]!.text).not.toContain("hello@agency.example");
      expect(sent[0]!.replyTo).toBeUndefined();
    } finally {
      await f.platform.notificationPreference.deleteMany({ where: { tenantId: f.tenantId } });
    }
  });

  it("is dead once replaced by a newer request, cancelled, expired, or the asker can no longer make the change", async () => {
    await requestReplyAddressAndMail(ctxOf("admin"), "first@agency.example");
    const first = lastToken();
    await requestReplyAddressAndMail(ctxOf("owner"), "second@agency.example");
    const second = lastToken();
    expect(await confirmReplyAddress(first)).toBe("dead");

    // Expired: seven days on.
    expect(await confirmReplyAddress(second, new Date(Date.now() + 8 * 86_400_000))).toBe("dead");

    await cancelReplyAddressRequest(ctxOf("owner"));
    expect(await confirmReplyAddress(second)).toBe("dead");
    expect((await f.audits("reply_address.request_cancelled")).at(-1)?.metadata).toMatchObject({
      email: "second@agency.example",
    });

    await requestReplyAddressAndMail(ctxOf("admin"), "third@agency.example");
    const third = lastToken();
    await f.platform.member.update({ where: { id: f.seats.admin.memberId }, data: { status: "SUSPENDED" } });
    expect(await readReplyAddressLink(third)).toBeNull();
    expect(await confirmReplyAddress(third)).toBe("dead");
    expect(await resolve()).toBe(ownerEmail);
  });

  it("refuses every malformed or forged token alike", async () => {
    await requestReplyAddressAndMail(ctxOf("owner"), "hello@agency.example");
    const token = lastToken();
    const [tenantPart, secret] = token.split(".");
    for (const bad of [
      "",
      "nonsense",
      `${tenantPart}.${"A".repeat(43)}`,
      `${"0".repeat(8)}-0000-7000-8000-${"0".repeat(12)}.${secret}`,
      `${token}x`,
    ]) {
      expect(await readReplyAddressLink(bad)).toBeNull();
      expect(await confirmReplyAddress(bad)).toBe("dead");
    }
    expect(await confirmReplyAddress(token)).toBe("confirmed");
  });
});

describe("removing it, and where it is carried", () => {
  it("removing it sends replies to the owner again, audited with the address", async () => {
    await requestReplyAddressAndMail(ctxOf("owner"), "hello@agency.example");
    expect(await confirmReplyAddress(lastToken())).toBe("confirmed");
    await expect(removeReplyAddress(ctxOf("employee"))).rejects.toBeInstanceOf(AuthzError);
    await removeReplyAddress(ctxOf("admin"));
    expect(await resolve()).toBe(ownerEmail);
    expect((await f.audits("reply_address.removed")).at(-1)?.metadata).toMatchObject({
      email: "hello@agency.example",
    });
  });

  it("an outbox mail and a direct one (an invitation) carry the confirmed address", async () => {
    await requestReplyAddressAndMail(ctxOf("owner"), "hello@agency.example");
    expect(await confirmReplyAddress(lastToken())).toBe("confirmed");
    await drainOutbox(50, { tenantId: f.tenantId }); // the owners' notice
    sent.length = 0;

    const employee = f.seats.employee.memberId;
    await f.platform.emailOutbox.create({
      data: {
        tenantId: f.tenantId,
        idempotencyKey: `weekly-reminder:${employee}:dbtest`,
        receiverType: "MEMBER",
        receiverId: employee,
        toEmail: "employee-replyto@test.invalid",
        kind: "time.weekly_reminder",
        locale: "en",
        notificationIds: [],
        sendAfter: new Date(Date.now() - 60_000),
      },
    });
    await drainOutbox(50, { tenantId: f.tenantId });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.replyTo).toBe("hello@agency.example");

    sent.length = 0;
    await createInvite({
      tenantId: f.tenantId,
      actor: f.seats.owner.actor,
      email: "new-person-replyto@test.invalid",
      roleIds: [f.roleId("employee")],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.replyTo).toBe("hello@agency.example");
  });
});
