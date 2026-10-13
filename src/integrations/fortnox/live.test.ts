import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * FORTNOX ITSELF, its requests pinned (Phase 4 slice 114; the design's §3 as
 * amended by §10): the consent URL a service account needs, the token calls'
 * Basic auth and TenantId header, only the configured hosts, `redirect:
 * "error"` — and a failure that never carries the secret, a token or a URL.
 * `src/config` parses the environment at load, so each case imports a fresh
 * copy (config.test.ts's shape); `fetch` is stubbed — nothing leaves.
 */
async function liveWith() {
  vi.resetModules();
  vi.stubEnv("FORTNOX_TRANSPORT", "live");
  vi.stubEnv("FORTNOX_CLIENT_ID", "app-id");
  vi.stubEnv("FORTNOX_CLIENT_SECRET", "s3cret-value");
  vi.stubEnv("APP_URL", "https://os.example.test");
  return (await import("./live")).liveFortnox;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("the live Fortnox client's requests", () => {
  it("the consent URL asks for a service account, our four scopes (spaces as %20), PKCE S256, and our callback", async () => {
    const live = await liveWith();
    const url = new URL(live.consentUrl({ state: "s".repeat(43), codeChallenge: "c".repeat(43) }));
    expect(`${url.origin}${url.pathname}`).toBe("https://apps.fortnox.se/oauth-v1/auth");
    expect(url.search).toContain("scope=bookkeeping%20companyinformation%20inbox%20connectfile");
    expect(url.searchParams.get("account_type")).toBe("service");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe("app-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://os.example.test/settings/invoicing/fortnox/callback");
    expect(url.search).not.toContain("s3cret");
  });

  it("a service token: Basic auth, the TenantId header, client credentials — and reused, not asked again", async () => {
    const live = await liveWith();
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return json(200, { access_token: "a".repeat(40), expires_in: 3600, token_type: "bearer" });
      }),
    );
    const deadline = Date.now() + 30_000;
    expect(await live.tenantToken("12345", deadline)).toBe("a".repeat(40));
    expect(await live.tenantToken("12345", deadline)).toBe("a".repeat(40));
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://apps.fortnox.se/oauth-v1/token");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("app-id:s3cret-value").toString("base64")}`);
    expect(headers.TenantId).toBe("12345");
    expect(String(init.body)).toBe("grant_type=client_credentials");
    expect(init.redirect).toBe("error");
  });

  it("a FRESH token always asks Fortnox — the connect's proof of a service consent never comes from the cache", async () => {
    const live = await liveWith();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return json(200, { access_token: `${"z".repeat(39)}${calls}`, expires_in: 3600 });
      }),
    );
    const deadline = Date.now() + 30_000;
    const first = await live.tenantToken("555", deadline);
    expect(await live.tenantToken("555", deadline)).toBe(first);
    const fresh = await live.tenantToken("555", deadline, { fresh: true });
    expect(fresh).not.toBe(first);
    expect(calls).toBe(2);
    // …and the fresh one is what the cache holds from then on.
    expect(await live.tenantToken("555", deadline)).toBe(fresh);
  });

  it("the code exchange sends the verifier and our callback, and keeps only the access token", async () => {
    const live = await liveWith();
    let body = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        body = String(init.body);
        return json(200, { access_token: "b".repeat(40), refresh_token: "r".repeat(40), expires_in: 3600 });
      }),
    );
    const out = await live.exchangeCode("the-code", "v".repeat(43), Date.now() + 30_000);
    expect(out).toEqual({ accessToken: "b".repeat(40), tenantIdClaim: null });
    expect(JSON.stringify(out)).not.toContain("r".repeat(40));
    const sent = new URLSearchParams(body);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code_verifier")).toBe("v".repeat(43));
    expect(sent.get("redirect_uri")).toBe("https://os.example.test/settings/invoicing/fortnox/callback");
  });

  it("a refusal is classified and carries no secret, token or URL", async () => {
    const live = await liveWith();
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { error: "invalid_client", error_description: "bad" })));
    const failure = await live.tenantToken("777", Date.now() + 30_000).catch((e: unknown) => e);
    expect(failure).toMatchObject({ kind: "auth", call: "token.tenant", status: 401 });
    const text = `${String(failure)} ${JSON.stringify(failure)}`;
    for (const secret of ["s3cret-value", "app-id", "apps.fortnox.se", "Basic"]) expect(text).not.toContain(secret);
  });

  it("a network failure, a timeout or a deadline too near is UNKNOWN — never a guess", async () => {
    const live = await liveWith();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(live.companyInformation("t".repeat(40), Date.now() + 30_000)).rejects.toMatchObject({ kind: "unknown" });
    await expect(live.companyInformation("t".repeat(40), Date.now() + 1_000)).rejects.toMatchObject({ kind: "unknown" });
  });

  it("a missing series or account is null (404), a GET's path values encoded", async () => {
    const live = await liveWith();
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return json(404, { ErrorInformation: { error: 1, message: "Not found", code: 2000423 } });
      }),
    );
    expect(await live.voucherSeries("t".repeat(40), "F/../x", 4, Date.now() + 30_000)).toBeNull();
    expect(await live.account("t".repeat(40), "1930", 4, Date.now() + 30_000)).toBeNull();
    expect(urls[0]).toBe("https://api.fortnox.se/3/voucherseries/F%2F..%2Fx?financialyear=4");
    expect(urls[1]).toBe("https://api.fortnox.se/3/accounts/1930?financialyear=4");
  });
});

describe("the nightly send's requests (slice 114b)", () => {
  const draft = {
    series: "F",
    date: "2026-10-12",
    description: "Betalning 1001",
    comments: "Fortleva 01920000-0000-7000-8000-000000000001",
    rows: [
      { account: "1930", amount: "125.00" },
      { account: "1510", amount: "-125.00" },
    ],
  };

  it("a voucher: POST to the year's vouchers, the body exactly as built, its number read back", async () => {
    const live = await liveWith();
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return json(201, { Voucher: { VoucherNumber: 7, VoucherSeries: "F", Year: 4 } });
      }),
    );
    expect(await live.createVoucher("t".repeat(40), 4, draft, Date.now() + 30_000)).toEqual({ year: 4, series: "F", number: 7 });
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.fortnox.se/3/vouchers?financialyear=4");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.body).toContain('"VoucherRows":[{"Account":1930,"Debit":125.00,"Credit":0},{"Account":1510,"Debit":0,"Credit":125.00}]');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${"t".repeat(40)}`);
  });

  it("a voucher Fortnox may have made (a 5xx, a timeout) is UNKNOWN; a refusal is certain", async () => {
    const live = await liveWith();
    vi.stubGlobal("fetch", vi.fn(async () => json(503, {})));
    await expect(live.createVoucher("t".repeat(40), 4, draft, Date.now() + 30_000)).rejects.toMatchObject({ kind: "unknown" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    );
    await expect(live.createVoucher("t".repeat(40), 4, draft, Date.now() + 30_000)).rejects.toMatchObject({ kind: "unknown" });
    vi.stubGlobal("fetch", vi.fn(async () => json(400, { ErrorInformation: { error: 1, message: "Perioden är låst", code: 2000106 } })));
    await expect(live.createVoucher("t".repeat(40), 4, draft, Date.now() + 30_000)).rejects.toMatchObject({ kind: "refused", code: "2000106" });
  });

  it("a voucher out of shape is refused before anything is sent", async () => {
    const live = await liveWith();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(live.createVoucher("t".repeat(40), 4, { ...draft, rows: [{ account: "1930", amount: "1.00" }] }, Date.now() + 30_000)).rejects.toMatchObject({
      kind: "shape",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a PDF into the voucher inbox as multipart; a file's connection read by its checked id", async () => {
    const live = await liveWith();
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return url.includes("/inbox")
          ? json(201, { File: { Id: "8f1e2d3c-0000-4000-8000-000000000001", Name: "Faktura 1001.pdf" } })
          : json(200, { VoucherFileConnection: { FileId: "8f1e2d3c-0000-4000-8000-000000000001", VoucherSeries: "F", VoucherNumber: "7" } });
      }),
    );
    const deadline = Date.now() + 30_000;
    const id = await live.uploadToInbox("t".repeat(40), new Uint8Array([37, 80, 68, 70]), "Faktura 1001.pdf", deadline);
    expect(id).toBe("8f1e2d3c-0000-4000-8000-000000000001");
    expect(calls[0]!.url).toBe("https://api.fortnox.se/3/inbox?path=inbox_v");
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(await live.fileConnection("t".repeat(40), id, deadline)).toEqual({ series: "F", number: 7 });
    expect(calls[1]!.url).toBe("https://api.fortnox.se/3/voucherfileconnections/8f1e2d3c-0000-4000-8000-000000000001");
    await expect(live.fileConnection("t".repeat(40), "../x", deadline)).rejects.toMatchObject({ kind: "shape" });
  });
});
