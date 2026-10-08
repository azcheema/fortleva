import { createSign, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  isPinnedCertUrl,
  isPinnedSubscribeUrl,
  normaliseFeedbackAddress,
  readSesFeedback,
  readSnsEnvelope,
  snsStringToSign,
  verifySnsSignature,
  type SnsEnvelope,
} from "./sns";

/**
 * Amazon SNS's envelope, signature and URL pins, and SES's feedback inside it
 * (Phase 5 slice 103, founder decision C71). The webhook BLOCKS ADDRESSES for
 * every workspace, so each check is pinned from both sides: what passes, and
 * each way to make it not pass. Signatures are made in the test with a key
 * generated here — no key material is committed.
 */

const HOST = "sns.eu-central-1.amazonaws.com";
const TOPIC = "arn:aws:sns:eu-central-1:123456789012:fortleva-mail-feedback";
const CERT = `https://${HOST}/SimpleNotificationService-9c6465fa7f48f5cacd23014631ec1136.pem`;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

function sign(e: Omit<SnsEnvelope, "Signature">, key = privateKey): SnsEnvelope {
  const unsigned = { ...e, Signature: "" } as SnsEnvelope;
  const signature = createSign(e.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1")
    .update(snsStringToSign(unsigned), "utf8")
    .sign(key, "base64");
  return { ...unsigned, Signature: signature };
}

const notification = (over: Partial<SnsEnvelope> = {}): SnsEnvelope =>
  sign({
    Type: "Notification",
    MessageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
    TopicArn: TOPIC,
    Message: JSON.stringify({ notificationType: "Bounce" }),
    Timestamp: "2026-10-08T12:00:00.000Z",
    SignatureVersion: "2",
    SigningCertURL: CERT,
    ...over,
  });

const confirmation = (over: Partial<SnsEnvelope> = {}): SnsEnvelope =>
  sign({
    Type: "SubscriptionConfirmation",
    MessageId: "165545c9-2a5c-472c-8df2-7ff2be2b3b1b",
    TopicArn: TOPIC,
    Message: "You have chosen to subscribe to the topic …",
    Timestamp: "2026-10-08T12:00:00.000Z",
    SignatureVersion: "2",
    SigningCertURL: CERT,
    Token: "2336412f37fb687f5d51e6e2425c464de12884…",
    SubscribeURL: `https://${HOST}/?Action=ConfirmSubscription&TopicArn=${TOPIC}&Token=abc`,
    ...over,
  });

describe("the string SNS signs", () => {
  it("is Name\\nValue\\n per covered field, in name order — a Notification without a Subject", () => {
    expect(snsStringToSign(notification())).toBe(
      [
        "Message",
        JSON.stringify({ notificationType: "Bounce" }),
        "MessageId",
        "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
        "Timestamp",
        "2026-10-08T12:00:00.000Z",
        "TopicArn",
        TOPIC,
        "Type",
        "Notification",
        "",
      ].join("\n"),
    );
  });

  // LITERAL STRINGS, written out by hand from AWS's documented format — never
  // computed by the function under test (the design review's medium: a
  // signature made and checked with one wrong function verifies perfectly,
  // and then every genuine message is refused in production).
  it("covers a Notification's Subject between MessageId and Timestamp when it has one", () => {
    expect(snsStringToSign(notification({ Subject: "Amazon SES Email Event Notification" }))).toBe(
      "Message\n" +
        '{"notificationType":"Bounce"}\n' +
        "MessageId\n" +
        "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324\n" +
        "Subject\n" +
        "Amazon SES Email Event Notification\n" +
        "Timestamp\n" +
        "2026-10-08T12:00:00.000Z\n" +
        "TopicArn\n" +
        "arn:aws:sns:eu-central-1:123456789012:fortleva-mail-feedback\n" +
        "Type\n" +
        "Notification\n",
    );
  });

  it("covers a confirmation's SubscribeURL and Token, in name order", () => {
    expect(snsStringToSign(confirmation())).toBe(
      "Message\n" +
        "You have chosen to subscribe to the topic …\n" +
        "MessageId\n" +
        "165545c9-2a5c-472c-8df2-7ff2be2b3b1b\n" +
        "SubscribeURL\n" +
        "https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:eu-central-1:123456789012:fortleva-mail-feedback&Token=abc\n" +
        "Timestamp\n" +
        "2026-10-08T12:00:00.000Z\n" +
        "Token\n" +
        "2336412f37fb687f5d51e6e2425c464de12884…\n" +
        "TopicArn\n" +
        "arn:aws:sns:eu-central-1:123456789012:fortleva-mail-feedback\n" +
        "Type\n" +
        "SubscriptionConfirmation\n",
    );
    // An unsubscribe confirmation covers the same fields.
    expect(snsStringToSign(confirmation({ Type: "UnsubscribeConfirmation" }))).toMatch(/\nType\nUnsubscribeConfirmation\n$/);
  });
});

describe("verifying the signature", () => {
  it("accepts version 2 (RSA-SHA256) and version 1 (RSA-SHA1) under the signer's key", () => {
    expect(verifySnsSignature(notification(), publicKey)).toBe(true);
    expect(verifySnsSignature(notification({ SignatureVersion: "1" }), publicKey)).toBe(true);
    expect(verifySnsSignature(confirmation(), publicKey)).toBe(true);
  });

  it("refuses another key", () => {
    expect(verifySnsSignature(notification(), other.publicKey)).toBe(false);
  });

  it("refuses EVERY signed field altered after signing — the topic above all", () => {
    const good = notification({ Subject: "s" });
    for (const [field, value] of [
      ["Message", JSON.stringify({ notificationType: "Complaint" })],
      ["MessageId", "x"],
      ["Subject", "t"],
      ["Timestamp", "2026-10-09T12:00:00.000Z"],
      ["TopicArn", "arn:aws:sns:eu-central-1:999999999999:theirs"],
    ] as const) {
      expect(verifySnsSignature({ ...good, [field]: value }, publicKey), field).toBe(false);
    }
    const c = confirmation();
    expect(verifySnsSignature({ ...c, SubscribeURL: "https://evil.example/" }, publicKey)).toBe(false);
    expect(verifySnsSignature({ ...c, Token: "other" }, publicKey)).toBe(false);
  });

  it("refuses a signature made under one version and presented as the other", () => {
    const v2 = notification();
    expect(verifySnsSignature({ ...v2, SignatureVersion: "1" }, publicKey)).toBe(false);
  });

  it("refuses rubbish without throwing", () => {
    expect(verifySnsSignature({ ...notification(), Signature: "not base64 at all!!" }, publicKey)).toBe(false);
    expect(verifySnsSignature({ ...notification(), Signature: "" }, publicKey)).toBe(false);
  });
});

describe("reading an envelope", () => {
  const raw = (e: SnsEnvelope) => JSON.parse(JSON.stringify(e)) as Record<string, unknown>;

  it("reads both kinds, dropping what the type does not cover", () => {
    const n = readSnsEnvelope({ ...raw(notification()), Token: "x", SubscribeURL: "y", UnsubscribeURL: "z" });
    expect(n?.Type).toBe("Notification");
    expect(n).not.toHaveProperty("Token");
    expect(readSnsEnvelope(raw(confirmation()))?.SubscribeURL).toContain("ConfirmSubscription");
  });

  it("treats a null Subject as no Subject (SNS sends null for a message published without one)", () => {
    const n = readSnsEnvelope({ ...raw(notification()), Subject: null });
    expect(n).not.toBeNull();
    expect(n).not.toHaveProperty("Subject");
  });

  it("refuses anything short of a whole envelope", () => {
    expect(readSnsEnvelope(null)).toBeNull();
    expect(readSnsEnvelope([])).toBeNull();
    expect(readSnsEnvelope("Notification")).toBeNull();
    expect(readSnsEnvelope({ ...raw(notification()), Type: "Other" })).toBeNull();
    expect(readSnsEnvelope({ ...raw(notification()), SignatureVersion: "3" })).toBeNull();
    // Version 1 (RSA-SHA1) is refused at the door — the topic is set to 2
    // (RUNBOOK §9), so a version-1 message is a misconfiguration or not ours.
    expect(readSnsEnvelope({ ...raw(notification({ SignatureVersion: "1" })) })).toBeNull();
    expect(readSnsEnvelope({ ...raw(notification()), SignatureVersion: 2 })).toBeNull();
    const without = (o: Record<string, unknown>, key: string) => {
      const copy = { ...o };
      delete copy[key];
      return copy;
    };
    for (const field of ["MessageId", "TopicArn", "Message", "Timestamp", "Signature", "SigningCertURL"]) {
      const rest = without(raw(notification()), field);
      expect(readSnsEnvelope(rest), field).toBeNull();
      expect(readSnsEnvelope({ ...rest, [field]: 1 }), field).toBeNull();
    }
    expect(readSnsEnvelope({ ...raw(notification()), Subject: 3 })).toBeNull();
    expect(readSnsEnvelope(without(raw(confirmation()), "Token"))).toBeNull();
    expect(readSnsEnvelope(without(raw(confirmation()), "SubscribeURL"))).toBeNull();
  });
});

describe("the certificate URL is pinned to AWS's host AND its certificate path", () => {
  it("accepts SNS's own certificate address", () => {
    expect(isPinnedCertUrl(CERT, HOST)).toBe(true);
  });

  it.each([
    ["http, not https", `http://${HOST}/SimpleNotificationService-abc.pem`],
    ["a host that merely begins like it", `https://${HOST}.evil.example/SimpleNotificationService-abc.pem`],
    ["credentials that make the real host evil.example", `https://${HOST}@evil.example/SimpleNotificationService-abc.pem`],
    ["a port", `https://${HOST}:8443/SimpleNotificationService-abc.pem`],
    ["another region's host", "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem"],
    ["another path on the host", `https://${HOST}/?Action=ListTopics`],
    ["a path that ends in .pem somewhere else", `https://${HOST}/x/SimpleNotificationService-abc.pem`],
    ["a dot segment", `https://${HOST}/SimpleNotificationService-../abc.pem`],
    ["a query", `https://${HOST}/SimpleNotificationService-abc.pem?x=1`],
    ["a fragment", `https://${HOST}/SimpleNotificationService-abc.pem#x`],
    ["a backslash the parser reads as a slash", `https://${HOST}\\@evil.example/SimpleNotificationService-abc.pem`],
    // Non-canonical spellings of the GENUINE address: each would be its own
    // cache key for the same certificate (the fix-pass review's low).
    ["an upper-case host", `https://SNS.eu-central-1.amazonaws.com/SimpleNotificationService-abc.pem`],
    ["the default port spelled out", `https://${HOST}:443/SimpleNotificationService-abc.pem`],
    // (A trailing dot on the host is refused by the host check itself.)
    ["a trailing dot on the host", `https://${HOST}./SimpleNotificationService-abc.pem`],
    ["not a URL", "SimpleNotificationService-abc.pem"],
  ])("refuses %s", (_why, url) => {
    expect(isPinnedCertUrl(url, HOST)).toBe(false);
  });
});

describe("the SubscribeURL is SNS's ConfirmSubscription for OUR topic", () => {
  it("accepts it", () => {
    expect(isPinnedSubscribeUrl(confirmation().SubscribeURL!, HOST, TOPIC)).toBe(true);
  });

  it.each([
    ["another host", `https://evil.example/?Action=ConfirmSubscription&TopicArn=${TOPIC}&Token=a`],
    ["http", `http://${HOST}/?Action=ConfirmSubscription&TopicArn=${TOPIC}&Token=a`],
    ["another action", `https://${HOST}/?Action=Unsubscribe&TopicArn=${TOPIC}&Token=a`],
    ["another topic", `https://${HOST}/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:eu-central-1:999999999999:t&Token=a`],
    ["no token", `https://${HOST}/?Action=ConfirmSubscription&TopicArn=${TOPIC}`],
    ["another path", `https://${HOST}/x?Action=ConfirmSubscription&TopicArn=${TOPIC}&Token=a`],
    ["credentials", `https://u:p@${HOST}/?Action=ConfirmSubscription&TopicArn=${TOPIC}&Token=a`],
  ])("refuses %s", (_why, url) => {
    expect(isPinnedSubscribeUrl(url, HOST, TOPIC)).toBe(false);
  });
});

describe("SES's feedback, read for what blocks an address", () => {
  const OURS = "123456789012";
  /** The `mail` object of a message OUR account sent to `to`. */
  const mailTo = (...to: string[]) => ({ messageId: "m", sendingAccountId: OURS, destination: to });
  const bounce = (
    bounceType: string,
    recipients: unknown[],
    opts: { key?: "notificationType" | "eventType"; subType?: string; to?: string[] } = {},
  ) =>
    JSON.stringify({
      [opts.key ?? "notificationType"]: "Bounce",
      bounce: { bounceType, bounceSubType: opts.subType ?? "General", bouncedRecipients: recipients },
      mail: mailTo(...(opts.to ?? ["gone@example.com"])),
    });
  const complaint = (complaintFeedbackType: unknown, to = ["annoyed@example.com"]) =>
    JSON.stringify({
      eventType: "Complaint",
      complaint: {
        ...(complaintFeedbackType === undefined ? {} : { complaintFeedbackType }),
        complainedRecipients: [{ emailAddress: "annoyed@example.com" }],
      },
      mail: mailTo(...to),
    });
  const blocks = (message: string) => readSesFeedback(message, OURS).feedback;

  it("a PERMANENT bounce blocks the mail's recipient — identity notifications and configuration-set events alike", () => {
    for (const key of ["notificationType", "eventType"] as const) {
      expect(
        readSesFeedback(bounce("Permanent", [{ emailAddress: "Gone@Example.com" }], { key, to: ["Gone@Example.com"] }), OURS),
        key,
      ).toEqual({ feedback: { reason: "HARD_BOUNCE", addresses: ["gone@example.com"] }, note: null });
    }
  });

  it("A FORGED DELIVERY REPORT BLOCKS ONLY THE FORGER — never the victims it names", () => {
    // A bounce's address is the remote server's `Final-Recipient`, which an
    // attacker who received one of our mails can write: here they answer the
    // mail sent to THEM with a report naming two victims. What is blocked is
    // the mail's own recipient — the attacker — and nobody else.
    const forged = bounce(
      "Permanent",
      [
        { emailAddress: "victim@example.com", action: "failed", status: "5.1.1" },
        { emailAddress: "founder@example.com", action: "failed", status: "5.1.1" },
      ],
      { to: ["attacker@evil.example"] },
    );
    expect(readSesFeedback(forged, OURS)).toEqual({
      feedback: { reason: "HARD_BOUNCE", addresses: ["attacker@evil.example"] },
      note: "Bounce: the report named another address; attributed to the mail's one recipient",
    });
    // A forwarding mailbox whose final address is dead: the address WE mail is
    // the one that keeps bouncing, so it is the one blocked.
    expect(blocks(bounce("Permanent", [{ emailAddress: "dead@old.example" }], { to: ["alias@example.com"] }))?.addresses).toEqual([
      "alias@example.com",
    ]);
    // Complaints take the same rule.
    expect(blocks(complaint("abuse", ["someone@example.com"]))?.addresses).toEqual(["someone@example.com"]);
  });

  it("REFUSES a mail with any number of recipients but one — Fortleva never sends one", () => {
    for (const to of [[], ["a@example.com", "b@example.com"]]) {
      const read = readSesFeedback(bounce("Permanent", [{ emailAddress: "a@example.com" }], { to }), OURS);
      expect(read.feedback, String(to.length)).toBeNull();
      expect(read.note).toBe(`Bounce: the mail had ${to.length} recipients, not one`);
    }
    expect(readSesFeedback(bounce("Permanent", [{ emailAddress: "a@example.com" }], { to: ["nope"] }), OURS)).toEqual({
      feedback: null,
      note: "Bounce: the mail's recipient is not an address",
    });
  });

  it("only when a reported recipient FAILED — a delayed 4.x report blocks nobody", () => {
    expect(
      readSesFeedback(
        bounce("Permanent", [
          { emailAddress: "gone@example.com", action: "delayed", status: "4.0.0" },
          { emailAddress: "gone@example.com", action: "failed", status: "4.4.7" },
          // A 5.x status whose action is not `failed`: the action half decides.
          { emailAddress: "gone@example.com", action: "delayed", status: "5.0.0" },
        ]),
        OURS,
      ),
    ).toEqual({ feedback: null, note: "Bounce: no recipient failed" });
    // One failed recipient beside a delayed one is enough.
    expect(
      blocks(
        bounce("Permanent", [
          { emailAddress: "gone@example.com", action: "delayed", status: "4.0.0" },
          { emailAddress: "gone@example.com", action: "failed", status: "5.1.1" },
        ]),
      )?.addresses,
    ).toEqual(["gone@example.com"]);
  });

  it("only the subtypes that are facts about OUR mail — never SES's global list or its policy decisions", () => {
    for (const subType of ["General", "NoEmail", "OnAccountSuppressionList"]) {
      expect(blocks(bounce("Permanent", [{ emailAddress: "gone@example.com" }], { subType })), subType).not.toBeNull();
    }
    for (const subType of ["Suppressed", "UnsubscribedRecipient", "EmailValidationSuppressed", "OnTenantSuppressionList", ""]) {
      const read = readSesFeedback(bounce("Permanent", [{ emailAddress: "gone@example.com" }], { subType }), OURS);
      expect(read.feedback, subType).toBeNull();
      expect(read.note, subType).toMatch(/^Bounce: permanent subtype .* not recorded$/);
    }
  });

  it("ONLY ABOUT MAIL OUR OWN ACCOUNT SENT — another account's genuine bounce blocks nobody, and says so", () => {
    // Any AWS account can list any address, send to it, and get a real signed
    // Permanent bounce naming it; if it ever reached our topic, this is what
    // stops it blocking that address for every workspace.
    const theirs = JSON.stringify({
      notificationType: "Bounce",
      bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "victim@example.com" }] },
      mail: { messageId: "m", sendingAccountId: "999999999999", destination: ["victim@example.com"] },
    });
    expect(readSesFeedback(theirs, OURS)).toEqual({ feedback: null, note: "Bounce: not about mail our account sent" });
    const unattributed = JSON.stringify({
      notificationType: "Bounce",
      bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "victim@example.com" }] },
    });
    expect(readSesFeedback(unattributed, OURS)).toEqual({ feedback: null, note: "Bounce: no mail object" });
  });

  it("a transient or undetermined bounce does not — it may deliver tomorrow — and is not worth a note", () => {
    expect(readSesFeedback(bounce("Transient", [{ emailAddress: "gone@example.com" }]), OURS)).toEqual({ feedback: null, note: null });
    expect(blocks(bounce("Undetermined", [{ emailAddress: "gone@example.com" }]))).toBeNull();
  });

  it("a SPAM REPORT blocks — no feedback type, abuse, fraud, other", () => {
    for (const type of [undefined, null, "abuse", "fraud", "other", "Abuse"]) {
      expect(blocks(complaint(type)), String(type)).toEqual({ reason: "COMPLAINT", addresses: ["annoyed@example.com"] });
    }
  });

  it("a complaint that is NOT a spam report blocks nobody — not-spam above all", () => {
    for (const type of ["not-spam", "NOT-SPAM", "auth-failure", "virus", 7]) {
      expect(readSesFeedback(complaint(type), OURS), String(type)).toEqual({ feedback: null, note: "Complaint: not a spam report" });
    }
  });

  it("everything else is not feedback about an address, and is ignored without a note", () => {
    for (const kind of ["Delivery", "Send", "Reject", "Open", "Click", "Rendering Failure", "DeliveryDelay"]) {
      expect(
        readSesFeedback(
          JSON.stringify({
            eventType: kind,
            bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "a@b.co" }] },
            mail: mailTo("a@b.co"),
          }),
          OURS,
        ),
        kind,
      ).toEqual({ feedback: null, note: null });
    }
    expect(blocks("not json")).toBeNull();
    expect(blocks("null")).toBeNull();
    expect(blocks(JSON.stringify({ notificationType: "Bounce", mail: mailTo("a@b.co") }))).toBeNull();
    // A complaint is about the mail itself: with no recipients listed, the
    // mail's one recipient is still the person who complained.
    expect(blocks(JSON.stringify({ notificationType: "Complaint", complaint: {}, mail: mailTo("a@b.co") }))).toEqual({
      reason: "COMPLAINT",
      addresses: ["a@b.co"],
    });
    expect(blocks(bounce("Permanent", []))).toBeNull();
  });

  it("normalises an address the way every suppression check compares it", () => {
    expect(normaliseFeedbackAddress("  Someone@Example.COM ")).toBe("someone@example.com");
    expect(normaliseFeedbackAddress("Some One <Someone@Example.com>")).toBe("someone@example.com");
    for (const bad of ["", "no-at", "a@b", "a b@c.d", "a@b@c.d", `${"x".repeat(250)}@example.com`, 42, null]) {
      expect(normaliseFeedbackAddress(bad), String(bad)).toBeNull();
    }
  });
});
