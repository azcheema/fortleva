import { afterEach, describe, expect, it, vi } from "vitest";

import {
  absoluteUrl,
  appUrl,
  mailFrom,
  sessionCookieAttributes,
} from "./index";

describe("INV-D2: single config module owns host, cookies, sender", () => {
  it("builds absolute URLs from APP_URL only", () => {
    expect(absoluteUrl("/portal/invite/abc")).toBe(
      new URL("/portal/invite/abc", appUrl).toString(),
    );
  });

  it("composes the mail From header from configured parts", () => {
    expect(mailFrom.header).toBe(`${mailFrom.name} <${mailFrom.address}>`);
  });

  it("platform plane uses SameSite=strict; others lax", () => {
    expect(sessionCookieAttributes("platform").sameSite).toBe("strict");
    expect(sessionCookieAttributes("member").sameSite).toBe("lax");
    expect(sessionCookieAttributes("portal").sameSite).toBe("lax");
  });
});

/**
 * `src/config` parses `process.env` at module load, so each case needs a
 * second, differently-configured copy: resetModules + a dynamic import,
 * the same shape `proxy.test.ts` uses.
 */
async function configWith(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("./index");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * THE MAIL ESCAPE HATCH IS A PRODUCTION BYPASS, so it is pinned like one.
 *
 * `next start` runs as production, where `src/mailer` refuses the dev
 * transport — which made every mail-SENDING flow untestable from a
 * browser, not merely the mail. `MAIL_DEV_OUTBOX=1` lifts that for the
 * Playwright harness, and a review objected that a lone env flag is
 * exactly the shape `next.config.ts` argues at length is FORGEABLE: both
 * `next start` and `playwright.config.ts` load `.env.local` first, and
 * every hosting platform has an env panel. So it takes a second
 * condition that is structural rather than typed — the app must be
 * serving itself on loopback, which a real deployment never is.
 */
describe("MAIL_DEV_OUTBOX needs the flag AND a loopback origin", () => {
  it("is off by default", async () => {
    const c = await configWith({ APP_URL: "https://os.example.test" });
    expect(c.allowDevMailOutbox).toBe(false);
  });

  it("is off with the flag alone on a real origin — the forgeable case", async () => {
    const c = await configWith({ APP_URL: "https://os.example.test", MAIL_DEV_OUTBOX: "1" });
    expect(c.allowDevMailOutbox).toBe(false);
  });

  it("is off on loopback without the flag", async () => {
    const c = await configWith({ APP_URL: "http://127.0.0.1:3457" });
    expect(c.allowDevMailOutbox).toBe(false);
  });

  it("is on only for both together — which is the harness", async () => {
    for (const origin of ["http://127.0.0.1:3457", "http://localhost:3000"]) {
      const c = await configWith({ APP_URL: origin, MAIL_DEV_OUTBOX: "1" });
      expect(c.allowDevMailOutbox, origin).toBe(true);
    }
  });

  it("DOES NOT CRASH THE APPLICATION on a value somebody would plausibly type", async () => {
    // It was `z.enum(["0","1"])`, so `MAIL_DEV_OUTBOX=true` made
    // `envSchema.parse` throw at module load — the whole app refusing to
    // boot with a message about an enum. Anything but "1" is simply off.
    for (const value of ["true", "false", "0", "", "yes"]) {
      const c = await configWith({ APP_URL: "http://127.0.0.1:3457", MAIL_DEV_OUTBOX: value });
      expect(c.allowDevMailOutbox, value).toBe(value === "1");
    }
  });
});

describe("TRUSTED_PROXY_HOPS is what makes a client address trustworthy", () => {
  it("defaults to one proxy — the deployment RUNBOOK documents", async () => {
    const c = await configWith({ APP_URL: "https://os.example.test" });
    expect(c.trustedProxyHops).toBe(1);
  });

  it("takes a declared count, and rejects a nonsensical one", async () => {
    const c = await configWith({ APP_URL: "https://os.example.test", TRUSTED_PROXY_HOPS: "2" });
    expect(c.trustedProxyHops).toBe(2);
    await expect(
      configWith({ APP_URL: "https://os.example.test", TRUSTED_PROXY_HOPS: "-1" }),
    ).rejects.toThrow();
  });
});

/**
 * THE RATE LIMITER'S ENV, pinned because two harnesses depend on it and a
 * deployment must not (slice 81). Empty means unset — `playwright.config.ts`
 * keeps `.env.local`'s dev Redis out of the server it starts by setting both
 * EMPTY, the only override `next start`'s env loader will not replace — but
 * in production that leniency holds only on loopback, and production never
 * boots without the secret the limiter's HMAC key derives from.
 */
describe("the rate limiter's configuration", () => {
  it("reads empty Upstash values as unset", async () => {
    const c = await configWith({ UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" });
    expect(c.upstashConfig).toBeNull();
  });

  it("uses Upstash when both values are given", async () => {
    const c = await configWith({ UPSTASH_REDIS_REST_URL: "https://rl.example.test", UPSTASH_REDIS_REST_TOKEN: "t" });
    expect(c.upstashConfig).toEqual({ url: "https://rl.example.test", token: "t" });
  });

  it("fails closed in production without BETTER_AUTH_SECRET — the module throws at load", async () => {
    await expect(
      configWith({ NODE_ENV: "production", APP_URL: "https://os.example.test", BETTER_AUTH_SECRET: "" }),
    ).rejects.toThrow(/BETTER_AUTH_SECRET/);
  });

  it("refuses an EMPTY Upstash value in production off loopback, and allows an absent one", async () => {
    const prod = { NODE_ENV: "production", APP_URL: "https://os.example.test", BETTER_AUTH_SECRET: "s" };
    await expect(configWith({ ...prod, UPSTASH_REDIS_REST_URL: "" })).rejects.toThrow(/UPSTASH_REDIS_REST_URL/);
    vi.unstubAllEnvs();
    const absent = await configWith(prod);
    expect(absent.upstashConfig).toBeNull();
  });

  it("allows the empty values on a loopback production build — the e2e server", async () => {
    const c = await configWith({
      NODE_ENV: "production",
      APP_URL: "http://127.0.0.1:3457",
      BETTER_AUTH_SECRET: "s",
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
    });
    expect(c.upstashConfig).toBeNull();
  });
});

/**
 * AMAZON SES (Phase 5 slice 103, founder decision C71). Every case sets each
 * SES variable — empty when it means "unset" — so a developer's `.env.local`
 * can never decide a case.
 */
describe("Amazon SES: which transport, where, and the feedback topic", () => {
  const none = {
    AMAZON_SES_REGION: "",
    AMAZON_SES_ACCESS_KEY_ID: "",
    AMAZON_SES_SECRET_ACCESS_KEY: "",
    AMAZON_SES_CONFIGURATION_SET: "",
    AMAZON_SES_FEEDBACK_TOPIC_ARN: "",
    MAIL_TRANSPORT: "",
    MAIL_DEV_RECIPIENTS: "",
    MAIL_SEND_TO_ANYONE: "",
    MAIL_FROM_NAME: "Fortleva",
  };
  const keys = { AMAZON_SES_ACCESS_KEY_ID: "AKIATEST", AMAZON_SES_SECRET_ACCESS_KEY: "secret" };
  const prod = {
    NODE_ENV: "production",
    APP_URL: "https://os.example.test",
    BETTER_AUTH_SECRET: "s",
    MAIL_FROM_ADDRESS: "no-reply@mailer.naxdor.com",
    MAIL_SEND_TO_ANYONE: "1",
  };

  it("A PRODUCTION BUILD OFF LOOPBACK IS NOT THE DEPLOYMENT UNTIL IT SAYS SO — a tunnel or a Preview with the keys keeps the dev transport", async () => {
    for (const flag of ["", "0", "true", "yes"]) {
      const c = await configWith({ ...none, ...prod, ...keys, MAIL_SEND_TO_ANYONE: flag });
      expect(c.mailTransportKind, flag).toBe("dev");
    }
  });

  it("refuses a From display name SES would reject — accents, quotes, commas, brackets", async () => {
    for (const name of ["Naxdor Byrå", 'Fortleva "Mail"', "Fortleva, Inc", "Fortleva <x>"]) {
      await expect(configWith({ ...none, ...prod, ...keys, MAIL_FROM_NAME: name }), name).rejects.toThrow(/MAIL_FROM_NAME/);
    }
    const plain = await configWith({ ...none, ...prod, ...keys, MAIL_FROM_NAME: "Naxdor Studio" });
    expect(plain.mailFrom.name).toBe("Naxdor Studio");
  });

  it("a deployment with both keys sends through Amazon SES, to anyone, in Frankfurt by default, on the pinned endpoint", async () => {
    const c = await configWith({ ...none, ...prod, ...keys });
    expect(c.mailTransportKind).toBe("amazon-ses");
    expect(c.amazonSesConfig).toEqual({
      region: "eu-central-1",
      endpoint: "https://email.eu-central-1.amazonaws.com",
      accessKeyId: "AKIATEST",
      secretAccessKey: "secret",
      configurationSet: null,
      allowedRecipients: null,
    });
  });

  it("no keys is no SES — and the mailer refuses each send in production, as it always has", async () => {
    const c = await configWith({ ...none, ...prod });
    expect(c.amazonSesConfig).toBeNull();
    expect(c.mailTransportKind).toBe("dev");
  });

  it("A DEVELOPER'S MACHINE NEVER SENDS REAL MAIL BY ACCIDENT — loopback, a LAN address or a tunnel, and the e2e server, all keep the dev transport with keys present", async () => {
    for (const origin of ["http://localhost:3000", "http://192.168.1.20:3000", "https://dev-tunnel.example.test"]) {
      const c = await configWith({ ...none, APP_URL: origin, ...keys });
      expect(c.amazonSesConfig, origin).not.toBeNull();
      expect(c.mailTransportKind, origin).toBe("dev");
    }
    const e2e = await configWith({ ...none, ...prod, APP_URL: "http://127.0.0.1:3457", ...keys });
    expect(e2e.mailTransportKind).toBe("dev");
  });

  it("…unless MAIL_TRANSPORT=amazon-ses asks for it on purpose — and then only to MAIL_DEV_RECIPIENTS", async () => {
    const on = await configWith({
      ...none,
      APP_URL: "http://localhost:3000",
      ...keys,
      MAIL_TRANSPORT: "amazon-ses",
      MAIL_DEV_RECIPIENTS: " Me@Kund.se , ",
      MAIL_FROM_ADDRESS: "no-reply@mailer.naxdor.com",
    });
    expect(on.mailTransportKind).toBe("amazon-ses");
    expect([...(on.amazonSesConfig?.allowedRecipients ?? [])]).toEqual(["me@kund.se"]);
    for (const value of ["1", "true", "ses", "AMAZON-SES"]) {
      const c = await configWith({ ...none, APP_URL: "http://localhost:3000", ...keys, MAIL_TRANSPORT: value });
      expect(c.mailTransportKind, value).toBe("dev");
    }
  });

  it("refuses the flag WITHOUT a recipient list — a dev server's outbox holds other people's mail", async () => {
    await expect(
      configWith({ ...none, APP_URL: "http://localhost:3000", ...keys, MAIL_TRANSPORT: "amazon-ses" }),
    ).rejects.toThrow(/MAIL_DEV_RECIPIENTS/);
  });

  it("refuses a placeholder From address once Amazon SES sends", async () => {
    await expect(configWith({ ...none, ...prod, ...keys, MAIL_FROM_ADDRESS: "dev@localhost.invalid" })).rejects.toThrow(
      /MAIL_FROM_ADDRESS/,
    );
    // Without SES the placeholder is the dev default, as ever.
    const dev = await configWith({ ...none, APP_URL: "http://localhost:3000", MAIL_FROM_ADDRESS: "dev@localhost.invalid" });
    expect(dev.mailFrom.address).toBe("dev@localhost.invalid");
  });

  it("REFUSES A REGION OUTSIDE AN EU MEMBER STATE, in every mode — London and Zurich included", async () => {
    for (const region of ["us-east-1", "eu", "eu-central", "ap-southeast-2", "EU-CENTRAL-1", "eu-west-2", "eu-central-2"]) {
      await expect(configWith({ ...none, AMAZON_SES_REGION: region }), region).rejects.toThrow(/AMAZON_SES_REGION/);
    }
    const stockholm = await configWith({ ...none, ...prod, ...keys, AMAZON_SES_REGION: "eu-north-1" });
    expect(stockholm.amazonSesConfig?.region).toBe("eu-north-1");
    expect(stockholm.amazonSesConfig?.endpoint).toBe("https://email.eu-north-1.amazonaws.com");
  });

  it("refuses one key without the other in production off loopback, not on loopback", async () => {
    await expect(configWith({ ...none, ...prod, AMAZON_SES_ACCESS_KEY_ID: "AKIATEST" })).rejects.toThrow(
      /AMAZON_SES_ACCESS_KEY_ID and AMAZON_SES_SECRET_ACCESS_KEY/,
    );
    await expect(configWith({ ...none, ...prod, AMAZON_SES_SECRET_ACCESS_KEY: "secret" })).rejects.toThrow(
      /must be set together/,
    );
    const harness = await configWith({ ...none, ...prod, APP_URL: "http://127.0.0.1:3457", AMAZON_SES_ACCESS_KEY_ID: "x" });
    expect(harness.amazonSesConfig).toBeNull();
  });

  it("takes a configuration set by name, and refuses anything that is not one", async () => {
    const c = await configWith({ ...none, ...prod, ...keys, AMAZON_SES_CONFIGURATION_SET: "fortleva-feedback" });
    expect(c.amazonSesConfig?.configurationSet).toBe("fortleva-feedback");
    await expect(configWith({ ...none, AMAZON_SES_CONFIGURATION_SET: "a set" })).rejects.toThrow(
      /AMAZON_SES_CONFIGURATION_SET/,
    );
  });

  it("the feedback topic pins the one SNS host its messages may name", async () => {
    const off = await configWith({ ...none });
    expect(off.mailFeedbackConfig).toBeNull();
    const arn = "arn:aws:sns:eu-central-1:123456789012:fortleva-mail-feedback";
    const c = await configWith({ ...none, AMAZON_SES_FEEDBACK_TOPIC_ARN: arn });
    expect(c.mailFeedbackConfig).toEqual({
      topicArn: arn,
      region: "eu-central-1",
      accountId: "123456789012",
      snsHost: "sns.eu-central-1.amazonaws.com",
    });
  });

  it("refuses a topic that is not an SNS topic ARN in the SES region", async () => {
    for (const arn of [
      "arn:aws:sns:eu-north-1:123456789012:t", // another region than SES's (eu-central-1)
      "arn:aws:sns:us-east-1:123456789012:t",
      "arn:aws:sqs:eu-central-1:123456789012:t",
      "arn:aws:sns:eu-central-1:12345:t",
      "arn:aws:sns:eu-central-1:123456789012:t.fifo",
      "https://sns.eu-central-1.amazonaws.com/",
    ]) {
      await expect(configWith({ ...none, AMAZON_SES_FEEDBACK_TOPIC_ARN: arn }), arn).rejects.toThrow(
        /AMAZON_SES_FEEDBACK_TOPIC_ARN/,
      );
    }
    const stockholm = await configWith({
      ...none,
      AMAZON_SES_REGION: "eu-north-1",
      AMAZON_SES_FEEDBACK_TOPIC_ARN: "arn:aws:sns:eu-north-1:123456789012:t",
    });
    expect(stockholm.mailFeedbackConfig?.snsHost).toBe("sns.eu-north-1.amazonaws.com");
  });
});
