import type { SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import { describe, expect, it } from "vitest";

import { amazonSesTransport, isReservedRecipient, RecipientRefusedError, sanitisedSesError, sendEmailInput } from "./amazon-ses";

/**
 * The Amazon SES transport (Phase 5 slice 103, founder decision C71): what it
 * asks SES to send, and what it says when SES refuses. The AWS call is
 * injected — nothing here reaches AWS.
 */

const config = {
  region: "eu-central-1",
  endpoint: "https://email.eu-central-1.amazonaws.com",
  accessKeyId: "AKIATEST",
  secretAccessKey: "s",
  configurationSet: null,
  allowedRecipients: null,
};
const msg = {
  from: "Fortleva <no-reply@mailer.example.test>",
  to: "person@kund.se",
  subject: "Ämne — åäö",
  text: "Hej\nhttps://os.example.test/x",
};

describe("what SES is asked to send", () => {
  it("one recipient, the From the config owns, the text as UTF-8 — and nothing it was not given", () => {
    expect(sendEmailInput(msg, null)).toEqual({
      FromEmailAddress: "Fortleva <no-reply@mailer.example.test>",
      Destination: { ToAddresses: ["person@kund.se"] },
      Content: {
        Simple: {
          Subject: { Data: "Ämne — åäö", Charset: "UTF-8" },
          Body: { Text: { Data: "Hej\nhttps://os.example.test/x", Charset: "UTF-8" } },
        },
      },
    });
  });

  it("carries the reply address and the configuration set when there are ones", () => {
    const input = sendEmailInput({ ...msg, replyTo: "studio@byra.se" }, "fortleva-feedback");
    expect(input.ReplyToAddresses).toEqual(["studio@byra.se"]);
    expect(input.ConfigurationSetName).toBe("fortleva-feedback");
  });

  it("carries RFC 8058's TWO headers for a one-click unsubscribe — the url in angle brackets", () => {
    const input = sendEmailInput({ ...msg, listUnsubscribe: "https://os.example.test/api/client-summary/unsubscribe/t" }, null);
    expect(input.Content?.Simple?.Headers).toEqual([
      { Name: "List-Unsubscribe", Value: "<https://os.example.test/api/client-summary/unsubscribe/t>" },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ]);
  });

  it("adds an HTML body only when a caller gives one", () => {
    expect(sendEmailInput({ ...msg, html: "<p>Hej</p>" }, null).Content?.Simple?.Body?.Html).toEqual({
      Data: "<p>Hej</p>",
      Charset: "UTF-8",
    });
  });

  it("attaches an invoice's PDF as a real attachment, its bytes untouched (slice 109, C79 (a))", () => {
    const content = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const input = sendEmailInput(
      { ...msg, attachments: [{ filename: "faktura-10001.pdf", contentType: "application/pdf", content }] },
      null,
    );
    expect(input.Content?.Simple?.Attachments).toEqual([
      {
        FileName: "faktura-10001.pdf",
        ContentType: "application/pdf",
        ContentDisposition: "ATTACHMENT",
        ContentTransferEncoding: "BASE64",
        RawContent: content,
      },
    ]);
    // No attachment given, none sent — not even an empty list.
    expect(sendEmailInput(msg, null).Content?.Simple).not.toHaveProperty("Attachments");
    expect(sendEmailInput({ ...msg, attachments: [] }, null).Content?.Simple).not.toHaveProperty("Attachments");
  });
});

describe("the transport", () => {
  it("hands the command to SES once", async () => {
    const calls: SendEmailCommandInput[] = [];
    await amazonSesTransport(config, async (input) => {
      calls.push(input);
    })(msg);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.Destination?.ToAddresses).toEqual(["person@kund.se"]);
  });

  it("RE-THROWS A REFUSAL AS ITS NAME AND STATUS — never SES's message, which can quote the address", async () => {
    const refusal = Object.assign(
      new Error("Email address is not verified. The following identities failed the check in region EU-CENTRAL-1: person@kund.se"),
      { name: "MessageRejected", $metadata: { httpStatusCode: 400 } },
    );
    const sendIt = amazonSesTransport(config, async () => {
      throw refusal;
    });
    await expect(sendIt(msg)).rejects.toThrow(/^amazon-ses: MessageRejected \(400\)$/);
    await expect(sendIt(msg)).rejects.not.toThrow(/person@kund\.se/);
  });

  it("REFUSES A RESERVED DOMAIN before SES is asked — every fixture address is one, and each would be a hard bounce", async () => {
    let asked = 0;
    const sendIt = amazonSesTransport(config, async () => {
      asked += 1;
    });
    for (const to of [
      "a@test.invalid",
      "a@e2e-undeliverable.invalid",
      "a@agency.example",
      "a@os.example.test",
      "a@localhost",
      "a@example.com",
      "a@mail.example.org",
      "no-at-sign",
    ]) {
      await expect(sendIt({ ...msg, to }), to).rejects.toThrow("amazon-ses: ReservedRecipientDomain");
      // A RecipientRefusedError — the class the outbox does not count as "the
      // transport is down" (`isRecipientRefusal`).
      await expect(sendIt({ ...msg, to }), to).rejects.toBeInstanceOf(RecipientRefusedError);
    }
    expect(asked).toBe(0);
    // Lookalikes are real domains.
    for (const to of ["a@notexample.com", "a@example.com.se", "a@testing.se"]) {
      expect(isReservedRecipient(to), to).toBe(false);
    }
  });

  it("OFF A DEPLOYMENT, mails only the addresses it was given", async () => {
    const calls: string[] = [];
    const sendIt = amazonSesTransport({ ...config, allowedRecipients: new Set(["me@kund.se"]) }, async (input) => {
      calls.push(input.Destination!.ToAddresses![0]!);
    });
    await sendIt({ ...msg, to: "Me@Kund.se" });
    await expect(sendIt({ ...msg, to: "someone-else@kund.se" })).rejects.toThrow("amazon-ses: RecipientNotAllowedHere");
    await expect(sendIt({ ...msg, to: "someone-else@kund.se" })).rejects.toBeInstanceOf(RecipientRefusedError);
    expect(calls).toEqual(["Me@Kund.se"]);
  });
});

describe("sanitisedSesError", () => {
  it("keeps a plain error name and the status, nothing else", () => {
    const e = Object.assign(new Error("x"), { name: "TooManyRequestsException", $metadata: { httpStatusCode: 429 } });
    expect(sanitisedSesError(e).message).toBe("amazon-ses: TooManyRequestsException (429)");
    expect(sanitisedSesError(new Error("boom")).message).toBe("amazon-ses: Error");
  });

  it("refuses a name that could smuggle text, and anything that is not an Error", () => {
    const e = Object.assign(new Error("x"), { name: "Bad name: person@kund.se" });
    expect(sanitisedSesError(e).message).toBe("amazon-ses: Error");
    expect(sanitisedSesError("person@kund.se").message).toBe("amazon-ses: Error");
    expect(sanitisedSesError({ $metadata: { httpStatusCode: "500" } }).message).toBe("amazon-ses: Error");
  });
});
