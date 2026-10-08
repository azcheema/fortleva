import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { isAddressSuppressed, withPlatform } from "@/db";
import { send, setTransport, type MailTransport } from "@/mailer";
import { RecipientRefusedError } from "@/mailer/amazon-ses";
import { setupTenant } from "@/members/dbtest-fixture";

import { liftMailBlock } from "./lift-mail-block";
import { recordMailFeedback } from "./mail-feedback";
import { drainOutbox } from "./outbox";

/**
 * Amazon SES's feedback, written down — and every `send()` honouring it
 * (Phase 5 slice 103, founder decision C71 (e)).
 *
 * **`email_suppression` IS GLOBAL** — no tenant, so no throwaway tenant can
 * hold these rows. Every address here is `<uuid>@dbtest-mail-feedback.invalid`
 * (RFC 2606: `.invalid` is never a real mailbox), made fresh per run; afterAll
 * deletes this run's rows by exact address, and beforeAll sweeps any the
 * domain left behind by a run that died. Nothing else in the table is read or
 * touched.
 */

const DOMAIN = "dbtest-mail-feedback.invalid";
const run = randomUUID().slice(0, 8);
const made: string[] = [];
const address = (label: string) => {
  const a = `${label}-${run}-${randomUUID().slice(0, 8)}@${DOMAIN}`;
  made.push(a);
  return a;
};

const SYSTEM = { type: "system", job: "dbtest-mail-feedback" } as const;

async function rowOf(email: string) {
  return withPlatform(SYSTEM, "dbtest: read one suppression row", (tx) =>
    tx.emailSuppression.findUnique({ where: { email } }),
  );
}

beforeAll(async () => {
  await withPlatform(
    SYSTEM,
    "dbtest: sweep this suite's leftover suppression rows",
    (tx) => tx.emailSuppression.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } }),
    { readOnly: false },
  );
});

afterAll(async () => {
  if (made.length === 0) return;
  await withPlatform(
    SYSTEM,
    "dbtest: delete this run's suppression rows",
    (tx) => tx.emailSuppression.deleteMany({ where: { email: { in: made.map((a) => a.toLowerCase()) } } }),
    { readOnly: false },
  );
});

describe("recordMailFeedback", () => {
  it("blocks each address once, as SES reported it", async () => {
    const a = address("bounce");
    const b = address("bounce");
    expect(await recordMailFeedback({ reason: "HARD_BOUNCE", addresses: [a, b, a] })).toBe(2);
    expect(await rowOf(a)).toMatchObject({ email: a, reason: "HARD_BOUNCE", source: "ses-sns" });
    expect(await rowOf(b)).toMatchObject({ reason: "HARD_BOUNCE" });
  });

  it("is idempotent — SNS delivers at least once", async () => {
    const a = address("again");
    expect(await recordMailFeedback({ reason: "COMPLAINT", addresses: [a] })).toBe(1);
    expect(await recordMailFeedback({ reason: "COMPLAINT", addresses: [a] })).toBe(0);
  });

  it("THE FIRST REASON STANDS — a support block is never rewritten by later feedback", async () => {
    const a = address("manual");
    await withPlatform(
      SYSTEM,
      "dbtest: a support block",
      (tx) => tx.emailSuppression.create({ data: { email: a, reason: "MANUAL", source: "manual" } }),
      { readOnly: false },
    );
    expect(await recordMailFeedback({ reason: "COMPLAINT", addresses: [a] })).toBe(0);
    expect(await rowOf(a)).toMatchObject({ reason: "MANUAL", source: "manual" });
  });

  it("writes nothing for an empty list", async () => {
    expect(await recordMailFeedback({ reason: "HARD_BOUNCE", addresses: [] })).toBe(0);
  });

  it("audits as the platform, with a count — never an address", async () => {
    const before = new Date(Date.now() - 1_000);
    const a = address("audited");
    await recordMailFeedback({ reason: "HARD_BOUNCE", addresses: [a] });
    const rows = await withPlatform(SYSTEM, "dbtest: read the feedback job's audit rows", (tx) =>
      tx.auditEvent.findMany({
        where: { action: "platform.system_job", createdAt: { gte: before }, metadata: { path: ["job"], equals: "mail-feedback" } },
        select: { tenantId: true, visibility: true, metadata: true },
      }),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.tenantId).toBeNull();
      expect(r.visibility).toBe("PLATFORM");
      expect(JSON.stringify(r.metadata)).not.toContain(DOMAIN);
    }
  });
});

describe("liftMailBlock — support's audited step (C71 (f))", () => {
  it("a dry run reports and removes nothing; the real run removes the row and audits address and reason", async () => {
    const a = address("lift");
    await recordMailFeedback({ reason: "COMPLAINT", addresses: [a] });
    const dry = await liftMailBlock(a.toUpperCase(), "asked by phone", true);
    expect(dry).toMatchObject({ found: true, removed: false, reason: "COMPLAINT", source: "ses-sns" });
    expect(await rowOf(a)).not.toBeNull();

    const before = new Date(Date.now() - 1_000);
    expect(await liftMailBlock(a, "asked by phone", false)).toMatchObject({ found: true, removed: true });
    expect(await rowOf(a)).toBeNull();
    expect(await isAddressSuppressed(a)).toBe(false);
    const audited = await withPlatform(SYSTEM, "dbtest: read the lift's audit row", (tx) =>
      tx.auditEvent.findMany({
        where: { action: "platform.system_job", createdAt: { gte: before }, metadata: { path: ["job"], equals: "lift-mail-block" } },
        select: { metadata: true },
      }),
    );
    expect(audited.some((r) => JSON.stringify(r.metadata).includes(a) && JSON.stringify(r.metadata).includes("asked by phone"))).toBe(
      true,
    );
  });

  it("says when there is nothing to lift, and refuses no reason", async () => {
    expect(await liftMailBlock(address("absent"), "check", false)).toEqual({ found: false });
    await expect(liftMailBlock(address("noreason"), "  ", false)).rejects.toThrow(/reason/);
  });
});

/**
 * The outbox's NEW branch: an address blocked between the claim's check and
 * the send. The claim compares the row's `to_email` EXACTLY while `send()`
 * lower-cases, so a mixed-case row against a lower-case block reaches the send
 * — deterministically, no race (the design review's test idea). With it, the
 * pass's own limits: three transport failures in a row, a refusal of one
 * recipient that is not one, and the caller's deadline. On its own throwaway
 * tenant (`mailfb-`, in DBTEST_PREFIXES), drained alone.
 */
describe("the outbox at send: a row blocked meanwhile, a transport that is down, the caller's deadline", () => {
  let f: Awaited<ReturnType<typeof setupTenant>>;
  let restore: MailTransport | null = null;
  const handed: string[] = [];

  beforeAll(async () => {
    f = await setupTenant("mailfb");
    restore = setTransport(async (msg) => {
      handed.push(msg.to);
    });
  }, 60_000);

  afterAll(async () => {
    if (restore) setTransport(restore);
    await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
    await f.cleanup();
  }, 60_000);

  /**
   * Five due weekly-reminder rows of this tenant, returned OLDEST FIRST — the
   * order the claim must send them in. Created NEWEST first (falling
   * `send_after`), so a claim that came back in creation, id or heap order
   * would attempt the wrong rows and fail these tests (the final check's nit).
   */
  const fiveRows = async (tag: string) => {
    await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
    const employee = f.seats.employee.memberId;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const row = await f.platform.emailOutbox.create({
        data: {
          tenantId: f.tenantId,
          idempotencyKey: `weekly-reminder:${employee}:${tag}:${i}`,
          receiverType: "MEMBER",
          receiverId: employee,
          toEmail: `${tag}-${i}-${run}@mailfb-dbtest.example.org`,
          kind: "time.weekly_reminder",
          locale: "en",
          notificationIds: [],
          sendAfter: new Date(Date.now() - 60_000 + (4 - i) * 1_000),
        },
      });
      ids.push(row.id);
    }
    return ids.reverse();
  };
  /** A transport that answers each send in turn from `script` ("ok" sends). */
  const scripted = (script: ("down" | "refused" | "ok")[]) => {
    let n = 0;
    return async () => {
      const step = script[n++] ?? "ok";
      if (step === "down") throw new Error("transport down");
      if (step === "refused") throw new RecipientRefusedError("ReservedRecipientDomain");
    };
  };
  const statusOf = async (ids: string[]) =>
    (await f.platform.emailOutbox.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, lockedAt: true, attempts: true } }))
      .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

  it("THREE TRANSPORT FAILURES IN A ROW END THE PASS, and the rows not attempted go straight back to the queue", async () => {
    const ids = await fiveRows("down");
    const swapped = setTransport(async () => {
      throw new Error("transport down");
    });
    try {
      const out = await drainOutbox(50, { tenantId: f.tenantId });
      expect(out).toMatchObject({ sent: 0, failed: 3 });
    } finally {
      setTransport(swapped);
    }
    const rows = await statusOf(ids);
    expect(rows.map((r) => r.status)).toEqual(["FAILED", "FAILED", "FAILED", "QUEUED", "QUEUED"]);
    // Not leased for ten minutes, and no attempt counted for the two.
    expect(rows.slice(3).every((r) => r.lockedAt === null && r.attempts === 0)).toBe(true);
  });

  it("THE RELEASE TAKES BACK ONLY THIS DRAIN'S LEASE — never a row another drain has leased since", async () => {
    const ids = await fiveRows("lease");
    // On the first send, a stand-in for drain B re-leases the LAST row (a fresh
    // `now()`, outside this drain's transactions) — as a reclaim would after
    // this drain stalled past its lease. Then the transport is down.
    let first = true;
    const swapped = setTransport(async () => {
      if (first) {
        first = false;
        await f.platform.$executeRaw`UPDATE email_outbox SET locked_at = now() WHERE id = ${ids[4]!}`;
      }
      throw new Error("transport down");
    });
    try {
      expect(await drainOutbox(50, { tenantId: f.tenantId })).toMatchObject({ failed: 3 });
    } finally {
      setTransport(swapped);
    }
    const rows = await statusOf(ids);
    expect(rows[3]).toMatchObject({ status: "QUEUED", lockedAt: null });
    // B's row keeps B's lease: releasing it would let a third drain send it again.
    expect(rows[4]!.status).toBe("SENDING");
    expect(rows[4]!.lockedAt).not.toBeNull();
  });

  it("the streak: a refusal leaves it alone, a SENT mail resets it", async () => {
    // down, down, refused, down → three transport failures: the fifth goes back.
    let ids = await fiveRows("streak-a");
    let swapped = setTransport(scripted(["down", "down", "refused", "down", "ok"]));
    try {
      expect(await drainOutbox(50, { tenantId: f.tenantId })).toMatchObject({ sent: 0, failed: 4 });
    } finally {
      setTransport(swapped);
    }
    expect((await statusOf(ids))[4]).toMatchObject({ status: "QUEUED", lockedAt: null });
    // down, down, ok, down, down → never three in a row: all five attempted.
    ids = await fiveRows("streak-b");
    swapped = setTransport(scripted(["down", "down", "ok", "down", "down"]));
    try {
      expect(await drainOutbox(50, { tenantId: f.tenantId })).toMatchObject({ sent: 1, failed: 4 });
    } finally {
      setTransport(swapped);
    }
    expect((await statusOf(ids)).map((r) => r.status)).toEqual(["FAILED", "FAILED", "SENT", "FAILED", "FAILED"]);
  });

  it("a refusal of ONE recipient is not 'the transport is down' — the pass goes on", async () => {
    const ids = await fiveRows("refused");
    const swapped = setTransport(async () => {
      throw new RecipientRefusedError("ReservedRecipientDomain");
    });
    try {
      expect(await drainOutbox(50, { tenantId: f.tenantId })).toMatchObject({ failed: 5 });
    } finally {
      setTransport(swapped);
    }
    expect((await statusOf(ids)).every((r) => r.status === "FAILED")).toBe(true);
  });

  it("claims nothing with under fifteen seconds left before the caller's deadline", async () => {
    const ids = await fiveRows("late");
    // Just under the 15-second margin: a claim made here, then released after
    // a slow round trip, would leave the same rows — so the margin must be
    // what refuses it, with time to spare for nothing else.
    const out = await drainOutbox(50, { tenantId: f.tenantId, sendUntil: Date.now() + 14_000 });
    expect(out).toEqual({ sent: 0, skipped: 0, suppressed: 0, failed: 0, dead: 0 });
    expect((await statusOf(ids)).every((r) => r.status === "QUEUED" && r.lockedAt === null)).toBe(true);
    expect(handed).toEqual([]);
    await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  });

  it("SUPPRESSED, no attempt counted, nothing handed to the transport", async () => {
    // Alone in the outbox: the rows the tests above handed back are due.
    await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
    const a = address("outbox");
    await recordMailFeedback({ reason: "HARD_BOUNCE", addresses: [a] });
    const employee = f.seats.employee.memberId;
    const row = await f.platform.emailOutbox.create({
      data: {
        tenantId: f.tenantId,
        idempotencyKey: `weekly-reminder:${employee}:mailfb`,
        receiverType: "MEMBER",
        receiverId: employee,
        toEmail: a.toUpperCase(),
        kind: "time.weekly_reminder",
        locale: "en",
        notificationIds: [],
        sendAfter: new Date(Date.now() - 60_000),
      },
    });
    // THE PREMISE, asserted (the code review's nit): the claim's exact-case
    // lookup misses this row, so only `send()` can be what suppresses it. If
    // the claim is ever made case-blind, this fails first — move the test to a
    // seam then, or it would quietly test the claim instead.
    expect(await f.platform.emailSuppression.findUnique({ where: { email: row.toEmail } })).toBeNull();
    const out = await drainOutbox(50, { tenantId: f.tenantId });
    expect(out).toMatchObject({ sent: 0, suppressed: 1 });
    expect(handed).toEqual([]);
    expect(await f.platform.emailOutbox.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: "SUPPRESSED",
      attempts: 0,
      sentAt: null,
      lockedAt: null,
    });
  });
});

describe("every send() honours the list (C71 (e))", () => {
  let real: MailTransport | null = null;
  const handed: string[] = [];

  beforeAll(() => {
    real = setTransport(async (msg) => {
      handed.push(msg.to);
    });
  });
  afterEach(() => {
    handed.length = 0;
  });
  afterAll(() => {
    if (real) setTransport(real);
  });

  it("answers 'suppressed' for a blocked address and never reaches the transport — whatever the case it is written in", async () => {
    const a = address("blocked");
    await recordMailFeedback({ reason: "COMPLAINT", addresses: [a] });
    expect(await isAddressSuppressed(a.toUpperCase())).toBe(true);
    expect(await send({ to: ` ${a.toUpperCase()} `, subject: "s", text: "t" })).toBe("suppressed");
    expect(handed).toEqual([]);
  });

  it("answers 'sent' for any other address, through the transport", async () => {
    const a = address("fine");
    expect(await isAddressSuppressed(a)).toBe(false);
    expect(await send({ to: a, subject: "s", text: "t" })).toBe("sent");
    expect(handed).toEqual([a]);
  });
});
