import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it } from "vitest";

import { RATE_LIMIT_POLICIES, setLimiter, type Limiter, type RateLimitBucket } from "@/ratelimit";

import {
  ADDRESS_LIMITED_PATHS,
  credentialStore,
  enforceAuthRateLimit,
  RATE_LIMITED_PATHS,
  signInAddress,
} from "./rate-limit-hook";

/**
 * The credential endpoints' limiter, as a contract about WHICH QUESTIONS it
 * asks — the buckets, their order and the subject strings — since what
 * Upstash then does with them is Upstash's. `src/auth/portal.dbtest.ts`
 * drives the same hook through the portal instance's real handler under
 * brute force.
 */

type Asked = { readonly bucket: RateLimitBucket; readonly subject: string };

/** Records every question; refuses the buckets it is told to. */
const recordingLimiter = (refuse: readonly RateLimitBucket[] = []): Limiter & { asked: Asked[] } => {
  const asked: Asked[] = [];
  return {
    name: "upstash",
    asked,
    async limit(bucket, subject) {
      asked.push({ bucket, subject });
      const ok = !refuse.includes(bucket);
      return { ok, remaining: ok ? 1 : 0, reset: 0 };
    },
  };
};

/** Counts per bucket and subject against the product's own policies; no clock. */
const countingLimiter = (): Limiter => {
  const spent = new Map<string, number>();
  return {
    name: "upstash",
    async limit(bucket, subject) {
      const key = `${bucket}|${subject}`;
      const used = spent.get(key) ?? 0;
      if (used >= RATE_LIMIT_POLICIES[bucket].limit) return { ok: false, remaining: 0, reset: 0 };
      spent.set(key, used + 1);
      return { ok: true, remaining: 0, reset: 0 };
    },
  };
};

const signIn = (email: unknown, ip = "198.51.100.7") => ({
  path: "/sign-in/email",
  headers: new Headers({ "x-forwarded-for": ip }),
  body: { email, password: "irrelevant" },
});

/** True when the hook let the request through. */
const passes = (ctx: Parameters<typeof enforceAuthRateLimit>[0], plane: Parameters<typeof enforceAuthRateLimit>[1]) =>
  enforceAuthRateLimit(ctx, plane).then(
    () => true,
    (e: unknown) => {
      if (e instanceof APIError && e.status === "TOO_MANY_REQUESTS") return false;
      throw e;
    },
  );

afterEach(() => setLimiter(null));

describe("signInAddress", () => {
  it("is the address as the account lookup reads it: trimmed and lower-cased", () => {
    expect(signInAddress({ email: "  Kane.Acmesson@Example.COM " })).toBe("kane.acmesson@example.com");
  });

  it("is null for a body that names no address", () => {
    for (const body of [undefined, null, "kane@example.com", 42, {}, { email: 7 }, { email: "   " }]) {
      expect(signInAddress(body)).toBeNull();
    }
  });

  it("is bounded — the caller writes the string", () => {
    expect(signInAddress({ email: `${"a".repeat(5000)}@example.com` })).toHaveLength(320);
  });
});

describe("enforceAuthRateLimit", () => {
  it("asks a password sign-in three questions in order: the IP by plane, then the credential from that source, then the credential", async () => {
    const limiter = recordingLimiter();
    setLimiter(limiter);
    await enforceAuthRateLimit(signIn("Kane@Example.com"), "portal");
    expect(limiter.asked).toEqual([
      { bucket: "auth.sign_in", subject: "portal:198.51.100.7" },
      { bucket: "auth.sign_in_address_ip", subject: JSON.stringify(["contact", "kane@example.com", "198.51.100.7"]) },
      { bucket: "auth.sign_in_address", subject: "contact:kane@example.com" },
    ]);
  });

  it("keys the credential by the table of passwords: member and console share one, the portal has its own", () => {
    expect(credentialStore("member")).toBe("user");
    expect(credentialStore("platform")).toBe("user");
    expect(credentialStore("portal")).toBe("contact");
  });

  it("gives one staff password ONE budget across /login and /ops/login", async () => {
    setLimiter(countingLimiter());
    const { limit } = RATE_LIMIT_POLICIES["auth.sign_in_address"];
    // From a fresh IP every time, alternating the two staff planes.
    for (let i = 0; i < limit; i++) {
      expect(await passes(signIn("op@example.com", `203.0.113.${i + 1}`), i % 2 === 0 ? "member" : "platform")).toBe(true);
    }
    expect(await passes(signIn("op@example.com", "203.0.113.200"), "platform")).toBe(false);
    expect(await passes(signIn("op@example.com", "203.0.113.201"), "member")).toBe(false);
    // The same address at the portal is another credential.
    expect(await passes(signIn("op@example.com", "203.0.113.202"), "portal")).toBe(true);
  });

  it("does not let one machine lock an address out — it takes several", async () => {
    setLimiter(countingLimiter());
    const perSource = RATE_LIMIT_POLICIES["auth.sign_in_address_ip"].limit;
    const ceiling = RATE_LIMIT_POLICIES["auth.sign_in_address"].limit;
    // One attacker IP: refused after its own five, and the owner, elsewhere, still gets in.
    for (let i = 0; i < perSource; i++) expect(await passes(signIn("kane@example.com", "198.51.100.66"), "portal")).toBe(true);
    for (let i = 0; i < 20; i++) expect(await passes(signIn("kane@example.com", "198.51.100.66"), "portal")).toBe(false);
    expect(await passes(signIn("kane@example.com", "192.0.2.10"), "portal")).toBe(true);
    // A refusal at the per-source question spent nothing of the ceiling: it
    // takes ceiling / perSource sources in all to close the account.
    expect(ceiling / perSource).toBeGreaterThanOrEqual(4);
  });

  it("refuses on the credential alone — the guesser who rents a new IP for every try", async () => {
    setLimiter(recordingLimiter(["auth.sign_in_address"]));
    const refusal = await enforceAuthRateLimit(signIn("kane@example.com"), "member").catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(APIError);
    expect((refusal as APIError).status).toBe("TOO_MANY_REQUESTS");
  });

  it("spends nothing of a later question when an earlier one refuses", async () => {
    const byIp = recordingLimiter(["auth.sign_in"]);
    setLimiter(byIp);
    await expect(enforceAuthRateLimit(signIn("kane@example.com"), "portal")).rejects.toBeInstanceOf(APIError);
    expect(byIp.asked.map((a) => a.bucket)).toEqual(["auth.sign_in"]);

    const bySource = recordingLimiter(["auth.sign_in_address_ip"]);
    setLimiter(bySource);
    await expect(enforceAuthRateLimit(signIn("kane@example.com"), "portal")).rejects.toBeInstanceOf(APIError);
    expect(bySource.asked.map((a) => a.bucket)).toEqual(["auth.sign_in", "auth.sign_in_address_ip"]);
  });

  it("says the same thing whichever budget ran out", async () => {
    const messageWhen = async (refuse: RateLimitBucket): Promise<string> => {
      setLimiter(recordingLimiter([refuse]));
      const e = (await enforceAuthRateLimit(signIn("kane@example.com"), "portal").catch((x: unknown) => x)) as APIError;
      return `${e.status}|${e.message}`;
    };
    const first = await messageWhen("auth.sign_in");
    expect(await messageWhen("auth.sign_in_address_ip")).toBe(first);
    expect(await messageWhen("auth.sign_in_address")).toBe(first);
  });

  it("asks no credential question of a body without one, nor of any other endpoint", async () => {
    const limiter = recordingLimiter();
    setLimiter(limiter);
    await enforceAuthRateLimit(signIn(undefined), "member");
    await enforceAuthRateLimit({ path: "/sign-up/email", body: { email: "kane@example.com" } }, "member");
    await enforceAuthRateLimit({ path: "/get-session", body: { email: "kane@example.com" } }, "member");
    expect(limiter.asked.map((a) => a.bucket)).toEqual(["auth.sign_in", "auth.sign_up"]);
  });

  it("limits all six session-gated password checks per IP, as sign-in", async () => {
    const paths = [
      "/change-password",
      "/verify-password",
      "/two-factor/enable",
      "/two-factor/disable",
      "/two-factor/get-totp-uri",
      "/two-factor/generate-backup-codes",
    ];
    const limiter = recordingLimiter();
    setLimiter(limiter);
    for (const path of paths) {
      await enforceAuthRateLimit({ path, headers: new Headers({ "x-forwarded-for": "198.51.100.9" }) }, "member");
    }
    expect(limiter.asked).toEqual(paths.map(() => ({ bucket: "auth.sign_in", subject: "member:198.51.100.9" })));
  });

  it("counts an IPv6 guesser at one account by its /48 — rotating /64s inside it is one source", async () => {
    setLimiter(countingLimiter());
    const { limit } = RATE_LIMIT_POLICIES["auth.sign_in_address_ip"];
    // A different /64 every time, all inside one /48 — a tunnel broker's grant.
    for (let i = 0; i < limit; i++) {
      expect(await passes(signIn("kane@example.com", `2001:470:1f0b:${(i + 1).toString(16)}::1`), "portal")).toBe(true);
    }
    expect(await passes(signIn("kane@example.com", "2001:470:1f0b:ffff::1"), "portal")).toBe(false);
    // Another /48 is another source.
    expect(await passes(signIn("kane@example.com", "2001:470:1f0c::1"), "portal")).toBe(true);
  });

  it("counts the per-IP question by /64 — a /48 can be a whole organisation sharing one plane", async () => {
    const limiter = recordingLimiter();
    setLimiter(limiter);
    await enforceAuthRateLimit(signIn("kane@example.com", "2001:470:1f0b:42::7"), "portal");
    expect(limiter.asked).toEqual([
      { bucket: "auth.sign_in", subject: "portal:2001:470:1f0b:42::/64" },
      { bucket: "auth.sign_in_address_ip", subject: JSON.stringify(["contact", "kane@example.com", "2001:470:1f0b::/48"]) },
      { bucket: "auth.sign_in_address", subject: "contact:kane@example.com" },
    ]);
  });

  it("keeps the per-source and per-credential windows equal — the four-source floor depends on it", () => {
    // With a shorter per-source window, one source could put its five into
    // the ceiling more than once per ceiling window, and fewer than four
    // sources would fill it. Nothing else would notice: the counting
    // limiters here have no clock.
    expect(RATE_LIMIT_POLICIES["auth.sign_in_address_ip"].window).toBe(RATE_LIMIT_POLICIES["auth.sign_in_address"].window);
  });

  it("reaches every per-credential path — it returns early for a path with no per-IP bucket", () => {
    // The hook leaves at once for a path RATE_LIMITED_PATHS does not name,
    // so a credential-limited path missing from it would be a limit that is
    // declared and never asked.
    for (const path of ADDRESS_LIMITED_PATHS) {
      expect(RATE_LIMITED_PATHS[path], path).toBeDefined();
    }
  });
});
