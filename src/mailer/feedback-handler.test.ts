import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import { FEEDBACK_BODY_MAX, handleMailFeedback, type FeedbackDeps } from "./feedback-handler";
import type { CertAnswer } from "./sns-cert";
import { snsStringToSign, type SesFeedback, type SnsEnvelope } from "./sns";

/**
 * `POST /api/mail-feedback`'s order of checks (Phase 5 slice 103, founder
 * decision C71) — every row of the answer table in `feedback-handler.ts`, and
 * above all: NOTHING IS FETCHED OR WRITTEN for a message that is not ours.
 */

const HOST = "sns.eu-central-1.amazonaws.com";
const TOPIC = "arn:aws:sns:eu-central-1:123456789012:fortleva-mail-feedback";
const CERT = `https://${HOST}/SimpleNotificationService-abc123.pem`;
const config = { topicArn: TOPIC, region: "eu-central-1", accountId: "123456789012", snsHost: HOST };

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function signed(e: Omit<SnsEnvelope, "Signature">): SnsEnvelope {
  const unsigned = { ...e, Signature: "" } as SnsEnvelope;
  const sig = createSign("RSA-SHA256").update(snsStringToSign(unsigned), "utf8").sign(privateKey, "base64");
  return { ...unsigned, Signature: sig };
}

const bounceMessage = JSON.stringify({
  notificationType: "Bounce",
  bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "Gone@Example.com" }] },
  mail: { messageId: "x", sendingAccountId: "123456789012", destination: ["gone@example.com"] },
});

const notification = (over: Partial<SnsEnvelope> = {}) =>
  signed({
    Type: "Notification",
    MessageId: "m-1",
    TopicArn: TOPIC,
    Message: bounceMessage,
    Timestamp: "2026-10-08T12:00:00.000Z",
    SignatureVersion: "2",
    SigningCertURL: CERT,
    ...over,
  });

const subscribeUrl = `https://${HOST}/?Action=ConfirmSubscription&TopicArn=${TOPIC}&Token=tok`;
const confirmation = (over: Partial<SnsEnvelope> = {}) =>
  signed({
    Type: "SubscriptionConfirmation",
    MessageId: "m-2",
    TopicArn: TOPIC,
    Message: "confirm",
    Timestamp: "2026-10-08T12:00:00.000Z",
    SignatureVersion: "2",
    SigningCertURL: CERT,
    Token: "tok",
    SubscribeURL: subscribeUrl,
    ...over,
  });

function post(body: string, type: string | null = "Notification", headers: Record<string, string> = {}): Request {
  return new Request("https://os.example.test/api/mail-feedback", {
    method: "POST",
    body,
    headers: { "content-type": "text/plain; charset=UTF-8", ...(type ? { "x-amz-sns-message-type": type } : {}), ...headers },
  });
}

type Seen = { loads: string[]; confirms: string[]; records: SesFeedback[] };

function deps(over: Partial<FeedbackDeps> & { key?: CertAnswer } = {}): { deps: FeedbackDeps; seen: Seen } {
  const seen: Seen = { loads: [], confirms: [], records: [] };
  const key: CertAnswer = over.key ?? (publicKey as KeyObject);
  return {
    seen,
    deps: {
      config,
      loadKey: async (url) => {
        seen.loads.push(url);
        return key;
      },
      confirm: async (url) => {
        seen.confirms.push(url);
        return true;
      },
      record: async (f) => {
        seen.records.push(f);
        return f.addresses.length;
      },
      // Five minutes after every fixture's signed Timestamp.
      now: () => new Date("2026-10-08T12:05:00.000Z"),
      ...over,
    },
  };
}

describe("a genuine bounce from our topic", () => {
  it("blocks the address: 200, recorded once, lower-cased", async () => {
    const { deps: d, seen } = deps();
    const res = await handleMailFeedback(post(JSON.stringify(notification())), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
    expect(seen.loads).toEqual([CERT]);
    expect(seen.records).toEqual([{ reason: "HARD_BOUNCE", addresses: ["gone@example.com"] }]);
  });

  it("answers 500 when the write fails, so SNS delivers it again", async () => {
    const { deps: d } = deps({
      record: async () => {
        throw Object.assign(new Error("Can't reach database"), { code: "P1001" });
      },
    });
    expect((await handleMailFeedback(post(JSON.stringify(notification())), d)).status).toBe(500);
  });

  it("answers 200 and writes nothing for an event that blocks nobody", async () => {
    const { deps: d, seen } = deps();
    const delivery = notification({ Message: JSON.stringify({ eventType: "Delivery" }) });
    expect((await handleMailFeedback(post(JSON.stringify(delivery)), d)).status).toBe(200);
    expect(seen.records).toEqual([]);
  });
});

describe("NOTHING IS FETCHED OR WRITTEN for a message that is not ours", () => {
  it("404 with no topic configured", async () => {
    const { deps: d, seen } = deps({ config: null });
    expect((await handleMailFeedback(post(JSON.stringify(notification())), d)).status).toBe(404);
    expect(seen.loads).toEqual([]);
  });

  it("403 for ANOTHER TOPIC — before any certificate is fetched, even when AWS really signed it", async () => {
    // Anybody may make an SNS topic in their own AWS account; SNS signs its
    // messages under the same certificate as ours.
    const { deps: d, seen } = deps();
    const theirs = notification({ TopicArn: "arn:aws:sns:eu-central-1:999999999999:theirs" });
    expect((await handleMailFeedback(post(JSON.stringify(theirs)), d)).status).toBe(403);
    expect(seen.loads).toEqual([]);
    expect(seen.records).toEqual([]);
  });

  it("403 for a signature that does not verify — a forged complaint blocks nobody", async () => {
    const { deps: d, seen } = deps();
    const forged = {
      ...notification(),
      Message: JSON.stringify({ notificationType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: "victim@example.com" }] }, mail: { sendingAccountId: "123456789012", destination: ["victim@example.com"] } }),
    };
    expect((await handleMailFeedback(post(JSON.stringify(forged)), d)).status).toBe(403);
    expect(seen.records).toEqual([]);
  });

  it("403 when the certificate is refused, 503 when AWS cannot be reached (SNS retries)", async () => {
    const refused = deps({ key: "refused" });
    expect((await handleMailFeedback(post(JSON.stringify(notification())), refused.deps)).status).toBe(403);
    const down = deps({ key: "unavailable" });
    expect((await handleMailFeedback(post(JSON.stringify(notification())), down.deps)).status).toBe(503);
    expect([...refused.seen.records, ...down.seen.records]).toEqual([]);
  });

  it("400 for a body that is not an envelope, or whose header disagrees with it", async () => {
    const { deps: d, seen } = deps();
    expect((await handleMailFeedback(post("not json"), d)).status).toBe(400);
    expect((await handleMailFeedback(post(JSON.stringify({ hello: "world" })), d)).status).toBe(400);
    expect((await handleMailFeedback(post(JSON.stringify(notification()), null), d)).status).toBe(400);
    expect((await handleMailFeedback(post(JSON.stringify(notification()), "SubscriptionConfirmation"), d)).status).toBe(400);
    expect(seen.loads).toEqual([]);
  });

  it("413 for a body over the cap — declared, or not", async () => {
    const { deps: d, seen } = deps();
    const big = "x".repeat(FEEDBACK_BODY_MAX + 1);
    expect((await handleMailFeedback(post(big), d)).status).toBe(413);
    // A DECLARED length over the cap is refused unread — a tiny body proves it
    // was the header, not the bytes, that answered.
    expect((await handleMailFeedback(post("{}", "Notification", { "content-length": String(FEEDBACK_BODY_MAX + 1) }), d)).status).toBe(
      413,
    );
    // No Content-Length: a stream body (Node's fetch wants `duplex` for one).
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "x-amz-sns-message-type": "Notification" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big));
          c.close();
        },
      }),
      duplex: "half",
    };
    const undeclared = new Request("https://os.example.test/api/mail-feedback", init);
    expect((await handleMailFeedback(undeclared, d)).status).toBe(413);
    expect(seen.loads).toEqual([]);
  });
});

describe("a message out of its time", () => {
  it("403 for a genuine message over three hours old — SNS never retries that late, a replay does", async () => {
    const { deps: d, seen } = deps({ now: () => new Date("2026-10-08T15:01:00.000Z") });
    expect((await handleMailFeedback(post(JSON.stringify(notification())), d)).status).toBe(403);
    expect(seen.records).toEqual([]);
  });

  it("403 for one dated from the future past the clock's slack; an hour late is still fine", async () => {
    const future = deps({ now: () => new Date("2026-10-08T11:40:00.000Z") });
    expect((await handleMailFeedback(post(JSON.stringify(notification())), future.deps)).status).toBe(403);
    const late = deps({ now: () => new Date("2026-10-08T13:00:00.000Z") });
    expect((await handleMailFeedback(post(JSON.stringify(notification())), late.deps)).status).toBe(200);
    expect(late.seen.records).toHaveLength(1);
  });
});

describe("the subscription handshake", () => {
  it("confirms our topic's subscription through the pinned SubscribeURL", async () => {
    const { deps: d, seen } = deps();
    const res = await handleMailFeedback(post(JSON.stringify(confirmation()), "SubscriptionConfirmation"), d);
    expect(res.status).toBe(200);
    expect(seen.confirms).toEqual([subscribeUrl]);
  });

  it("answers 503 when the confirmation did not go through, so SNS can send it again", async () => {
    const { deps: d } = deps({ confirm: async () => false });
    expect((await handleMailFeedback(post(JSON.stringify(confirmation()), "SubscriptionConfirmation"), d)).status).toBe(503);
  });

  it("never fetches a SubscribeURL off the pinned host, even when it is signed", async () => {
    const { deps: d, seen } = deps();
    const elsewhere = confirmation({ SubscribeURL: "https://evil.example/?Action=ConfirmSubscription" });
    expect((await handleMailFeedback(post(JSON.stringify(elsewhere), "SubscriptionConfirmation"), d)).status).toBe(403);
    expect(seen.confirms).toEqual([]);
  });

  it("acknowledges an unsubscribe and does nothing else", async () => {
    const { deps: d, seen } = deps();
    const bye = confirmation({ Type: "UnsubscribeConfirmation" });
    expect((await handleMailFeedback(post(JSON.stringify(bye), "UnsubscribeConfirmation"), d)).status).toBe(200);
    expect(seen.confirms).toEqual([]);
    expect(seen.records).toEqual([]);
  });
});
