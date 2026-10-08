import { afterEach, describe, expect, it, vi } from "vitest";

import { pushEndpointUrl } from "@/config";

import { classifyPushStatus, webPushTransport } from "./send";

describe("classifyPushStatus — what an answer means for the DEVICE", () => {
  it("delivered on 2xx; gone on 404 and 410", () => {
    for (const s of [200, 201, 202, 204]) expect(classifyPushStatus(s)).toEqual({ kind: "delivered" });
    expect(classifyPushStatus(404)).toEqual({ kind: "gone", status: 404 });
    expect(classifyPushStatus(410)).toEqual({ kind: "gone", status: 410 });
  });

  it("NEVER counts 401, 403, 406, 429 or 5xx against the device — they are ours or the vendor's (both reviews' medium)", () => {
    for (const s of [401, 403, 406, 429, 500, 502, 503, 504]) {
      expect(classifyPushStatus(s), String(s)).toEqual({ kind: "transient", status: s, error: null });
    }
  });

  it("counts the rest of 4xx and any 3xx: the service refuses THIS subscription", () => {
    for (const s of [301, 302, 400, 413, 418, 422]) {
      expect(classifyPushStatus(s), String(s)).toEqual({ kind: "refused", status: s });
    }
  });
});

describe("webPushTransport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to the endpoint, follows no redirect, has a deadline, and never reads the answer", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => ({ status: 201, body: { cancel } }) as unknown as Response);
    vi.stubGlobal("fetch", fetch);
    const endpoint = new URL("https://fcm.googleapis.com/fcm/send/abc");
    const out = await webPushTransport({ endpoint, headers: { TTL: "60" }, body: Buffer.from("x") });
    expect(out).toEqual({ kind: "delivered" });
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url).toBe(endpoint);
    expect(init).toMatchObject({ method: "POST", redirect: "manual", cache: "no-store" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(cancel).toHaveBeenCalled();
  });

  it("refuses at the last moment an endpoint the fence does not admit, without a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await webPushTransport({ endpoint: new URL("https://evil.example/x"), headers: {}, body: Buffer.alloc(0) })).toMatchObject({
      kind: "refused",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a network failure is the vendor's trouble, named by its error's NAME only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed https://fcm.googleapis.com/fcm/send/secret-device");
      }),
    );
    const out = await webPushTransport({ endpoint: new URL("https://fcm.googleapis.com/fcm/send/abc"), headers: {}, body: Buffer.alloc(0) });
    expect(out).toEqual({ kind: "transient", status: null, error: "TypeError" });
  });
});

describe("pushEndpointUrl — the fence around a URL the member's browser chose (SSRF)", () => {
  it("admits the four vendors' push services", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc:def",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAAA",
      "https://web.push.apple.com/QKr4",
      "https://api.push.apple.com/3/device/x",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB",
      "https://FCM.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:443/fcm/send/abc",
    ]) {
      expect(pushEndpointUrl(ok), ok).not.toBeNull();
    }
  });

  it("refuses everything else: other hosts, lookalikes, the bare suffix, http, userinfo, ports, fragments, IPs, a trailing dot", () => {
    for (const bad of [
      "https://evil.example/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evilfcm.googleapis.com/x",
      "https://notify.windows.com/w/",
      "https://push.apple.com/x",
      "https://xpush.apple.com/x",
      "https://evil.example/.notify.windows.com",
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://user:pass@fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com@evil.example/x",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://fcm.googleapis.com/fcm/send/abc#frag",
      "https://142.250.74.106/fcm/send/abc",
      "https://[::1]/x",
      "https://fcm.googleapis.com./fcm/send/abc",
      "https://localhost/x",
      "javascript:alert(1)",
      "",
      `https://fcm.googleapis.com/${"a".repeat(1100)}`,
    ]) {
      expect(pushEndpointUrl(bad), bad).toBeNull();
    }
  });

  it("refuses what is not a string", () => {
    expect(pushEndpointUrl(42 as unknown as string)).toBeNull();
    expect(pushEndpointUrl(null as unknown as string)).toBeNull();
  });
});
