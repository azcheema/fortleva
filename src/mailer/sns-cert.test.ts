import { afterEach, describe, expect, it } from "vitest";

import { loadSnsSigningKey, resetSnsCertCache } from "./sns-cert";

/**
 * The SNS signing certificate's loader (Phase 5 slice 103): only a pinned URL
 * is ever fetched, an unreachable AWS is "unavailable" (SNS retries) and a bad
 * answer "refused", a certificate counts only inside its validity window, and
 * one fetch serves every message until it expires. `fetch` is injected.
 */

const HOST = "sns.eu-central-1.amazonaws.com";
const URL_OK = `https://${HOST}/SimpleNotificationService-abc123.pem`;

/**
 * A self-signed certificate made for this test with `openssl req -x509` on
 * 2026-10-08 (CN=test-only.invalid, valid 2026-10-08 → 2036-10-05). PUBLIC
 * MATERIAL ONLY — its private key was discarded at once; the loader needs a
 * real X.509 file to parse, never a key that signs.
 */
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDGTCCAgGgAwIBAgIUBMJ8x54bjis7mNgfqJC4ENXbyhEwDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRdGVzdC1vbmx5LmludmFsaWQwHhcNMjYxMDA4MDkyMDUx
WhcNMzYxMDA1MDkyMDUxWjAcMRowGAYDVQQDDBF0ZXN0LW9ubHkuaW52YWxpZDCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALcREZ7XVs0C428Cdujwiyfk
fUIY/7W7fv9SdiHWrFviPwtvEzXd4wJGUUqpcJDN3FEd3td5MY+mEL5SRuAlx4lm
NZXnkJ+vzh7skDydwg1SHmowCmjpXqdF/uiLjhoEkqqMmUqq6O+CJ0OVb7LmX/fM
RqT2BJEA9rh/mggYBAzkRuOg5SE0OeTdAUnxLB1GvieHtj1sStKBmqEL344BVV3X
n6YcokjPkDrAaxABb1GuGkFcb/BGrBn/NvJ8iAQzOZdx6MS05fphDdwBjHpKIaN3
q23GF0gZqj7CLtuLj4775YwAzohvSGRdcICjkCmufqS7rEN81Z02PHyPa5SImfMC
AwEAAaNTMFEwHQYDVR0OBBYEFC9KipXgVEEBIU8bGs6zliaiAHDPMB8GA1UdIwQY
MBaAFC9KipXgVEEBIU8bGs6zliaiAHDPMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZI
hvcNAQELBQADggEBAINypsUsJPWwozLR0csQKcAlFFNcITXKqcv8nyCqhvuW51g+
RnWnVHVHvWKLLEoaDcueAm9Yszoubow9cii2ML/EiyjYAuqohsy9NhkP4ZbnaGSy
s5g8kmA2pqPljBdoLbcrI8mBnwJqinVXKNduZ4s0dTnftMC6/0yMNB0H9STNNVYa
lzz9/SWgGfvTgO+tRLvQdD/Ua3M2r8pL2VQCaCecf/DNfqJJep4HgDCc5xDY8fbf
as3qqxm4WoT2BAE30wAt+92hIw55cj2pBOL6+YY+JdmXNmUPtFjKGkGLI7DWRa8w
5yLAkT8aiTYHmL0CR6t6NNsHeG/z2DMdqBhiiCY=
-----END CERTIFICATE-----
`;

const INSIDE = new Date("2027-01-01T00:00:00Z");

type Call = { url: string; redirect: RequestRedirect | undefined };

function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), redirect: init?.redirect });
    return answer();
  }) as typeof fetch;
  return { impl, calls };
}

afterEach(() => resetSnsCertCache());

describe("loadSnsSigningKey", () => {
  it("fetches a pinned URL once, without following redirects, and answers the certificate's key", async () => {
    const f = fakeFetch(() => new Response(TEST_CERT));
    const key = await loadSnsSigningKey(URL_OK, HOST, INSIDE, f.impl);
    expect(typeof key === "object" && key.type).toBe("public");
    expect(f.calls).toEqual([{ url: URL_OK, redirect: "error" }]);
  });

  it("serves the next message from the cache", async () => {
    const f = fakeFetch(() => new Response(TEST_CERT));
    await loadSnsSigningKey(URL_OK, HOST, INSIDE, f.impl);
    await loadSnsSigningKey(URL_OK, HOST, INSIDE, f.impl);
    expect(f.calls).toHaveLength(1);
  });

  it("NEVER FETCHES an unpinned URL", async () => {
    const f = fakeFetch(() => new Response(TEST_CERT));
    for (const url of [
      "https://evil.example/SimpleNotificationService-abc.pem",
      `http://${HOST}/SimpleNotificationService-abc.pem`,
      `https://${HOST}/other.pem`,
    ]) {
      expect(await loadSnsSigningKey(url, HOST, INSIDE, f.impl), url).toBe("refused");
    }
    expect(f.calls).toEqual([]);
  });

  it("refuses a certificate outside its validity window — before it starts, and once it has expired", async () => {
    const f = fakeFetch(() => new Response(TEST_CERT));
    expect(await loadSnsSigningKey(URL_OK, HOST, new Date("2026-01-01T00:00:00Z"), f.impl)).toBe("refused");
    expect(await loadSnsSigningKey(URL_OK, HOST, new Date("2037-01-01T00:00:00Z"), f.impl)).toBe("refused");
  });

  it("does not serve an expired certificate from the cache", async () => {
    const f = fakeFetch(() => new Response(TEST_CERT));
    expect(typeof (await loadSnsSigningKey(URL_OK, HOST, INSIDE, f.impl))).toBe("object");
    expect(await loadSnsSigningKey(URL_OK, HOST, new Date("2037-01-01T00:00:00Z"), f.impl)).toBe("refused");
    expect(f.calls).toHaveLength(2);
  });

  it("refuses what is not a certificate, or is too large to be one", async () => {
    expect(await loadSnsSigningKey(URL_OK, HOST, INSIDE, fakeFetch(() => new Response("<html>hi</html>")).impl)).toBe(
      "refused",
    );
    const huge = "x".repeat(17 * 1024);
    expect(await loadSnsSigningKey(URL_OK, HOST, INSIDE, fakeFetch(() => new Response(huge)).impl)).toBe("refused");
  });

  it("an AWS that cannot be reached is 'unavailable' (SNS retries); a 404 is 'refused'", async () => {
    const down = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await loadSnsSigningKey(URL_OK, HOST, INSIDE, down.impl)).toBe("unavailable");
    expect(await loadSnsSigningKey(URL_OK, HOST, INSIDE, fakeFetch(() => new Response("", { status: 503 })).impl)).toBe(
      "unavailable",
    );
    expect(await loadSnsSigningKey(URL_OK, HOST, INSIDE, fakeFetch(() => new Response("", { status: 404 })).impl)).toBe(
      "refused",
    );
  });

  it("remembers a REFUSED URL for a minute — no second fetch of a made-up certificate", async () => {
    const f = fakeFetch(() => new Response("", { status: 404 }));
    const odd = `https://${HOST}/SimpleNotificationService-madeup.pem`;
    expect(await loadSnsSigningKey(odd, HOST, INSIDE, f.impl)).toBe("refused");
    expect(await loadSnsSigningKey(odd, HOST, new Date(INSIDE.getTime() + 30_000), f.impl)).toBe("refused");
    expect(f.calls).toHaveLength(1);
    expect(await loadSnsSigningKey(odd, HOST, new Date(INSIDE.getTime() + 61_000), f.impl)).toBe("refused");
    expect(f.calls).toHaveLength(2);
  });

  it("lets at most twenty uncached fetches a minute leave the process — the cached certificate still answers", async () => {
    const good = fakeFetch(() => new Response(TEST_CERT));
    expect(typeof (await loadSnsSigningKey(URL_OK, HOST, INSIDE, good.impl))).toBe("object");
    const f = fakeFetch(() => new Response("", { status: 404 }));
    for (let i = 0; i < 19; i++) {
      await loadSnsSigningKey(`https://${HOST}/SimpleNotificationService-x${i}.pem`, HOST, INSIDE, f.impl);
    }
    expect(f.calls).toHaveLength(19);
    expect(await loadSnsSigningKey(`https://${HOST}/SimpleNotificationService-y.pem`, HOST, INSIDE, f.impl)).toBe(
      "unavailable",
    );
    expect(f.calls).toHaveLength(19);
    // The genuine certificate is cached, so genuine mail is untouched.
    expect(typeof (await loadSnsSigningKey(URL_OK, HOST, INSIDE, good.impl))).toBe("object");
    expect(good.calls).toHaveLength(1);
  });

  it("AWS's 429 is 'unavailable' (SNS retries) and is not remembered as a refusal", async () => {
    let n = 0;
    const f = fakeFetch(() => (n++ === 0 ? new Response("", { status: 429 }) : new Response(TEST_CERT)));
    expect(await loadSnsSigningKey(URL_OK, HOST, INSIDE, f.impl)).toBe("unavailable");
    expect(typeof (await loadSnsSigningKey(URL_OK, HOST, INSIDE, f.impl))).toBe("object");
    expect(f.calls).toHaveLength(2);
  });

  it("concurrent messages share ONE fetch of a certificate", async () => {
    let release: (r: Response) => void = () => {};
    const f = fakeFetch(() => new Promise<Response>((resolve) => (release = resolve)));
    const a = loadSnsSigningKey(URL_OK, HOST, INSIDE, f.impl);
    const b = loadSnsSigningKey(URL_OK, HOST, INSIDE, f.impl);
    release(new Response(TEST_CERT));
    const [ka, kb] = await Promise.all([a, b]);
    expect(typeof ka === "object" && typeof kb === "object").toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  it("caches no failure — the next message tries again", async () => {
    let n = 0;
    const f = fakeFetch(() => (n++ === 0 ? new Response("", { status: 503 }) : new Response(TEST_CERT)));
    expect(await loadSnsSigningKey(URL_OK, HOST, INSIDE, f.impl)).toBe("unavailable");
    expect(typeof (await loadSnsSigningKey(URL_OK, HOST, INSIDE, f.impl))).toBe("object");
  });
});
