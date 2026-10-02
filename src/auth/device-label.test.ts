import { describe, expect, it } from "vitest";

import { deviceLabel, networkOf } from "./device-label";

describe("deviceLabel", () => {
  it.each([
    [
      "Chrome on Windows",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      { browser: "Chrome", os: "Windows", kind: "desktop" },
    ],
    [
      "Edge, which also says Chrome",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
      { browser: "Edge", os: "Windows", kind: "desktop" },
    ],
    [
      "Opera, which also says Chrome",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0",
      { browser: "Opera", os: "macOS", kind: "desktop" },
    ],
    [
      "Safari on a Mac",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      { browser: "Safari", os: "macOS", kind: "desktop" },
    ],
    [
      "Safari on an iPhone",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      { browser: "Safari", os: "iOS", kind: "mobile" },
    ],
    [
      "Chrome on an iPad",
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.0.0 Mobile/15E148 Safari/604.1",
      { browser: "Chrome", os: "iOS", kind: "tablet" },
    ],
    [
      "Firefox on Linux",
      "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
      { browser: "Firefox", os: "Linux", kind: "desktop" },
    ],
    [
      "Chrome on an Android phone",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
      { browser: "Chrome", os: "Android", kind: "mobile" },
    ],
    [
      "Samsung Internet on an Android tablet",
      "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Safari/537.36",
      { browser: "Samsung Internet", os: "Android", kind: "tablet" },
    ],
  ])("%s", (_name, ua, expected) => {
    expect(deviceLabel(ua)).toEqual(expected);
  });

  it("names headless Chromium (the browser tests' own) as Chrome", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36",
      ),
    ).toEqual({ browser: "Chrome", os: "Windows", kind: "desktop" });
  });

  it("recognises nothing it does not know, and never throws", () => {
    expect(deviceLabel(null)).toEqual({ browser: null, os: null, kind: "desktop" });
    expect(deviceLabel("")).toEqual({ browser: null, os: null, kind: "desktop" });
    expect(deviceLabel("curl/8.4.0")).toEqual({ browser: null, os: null, kind: "desktop" });
    expect(deviceLabel("x".repeat(100_000))).toEqual({ browser: null, os: null, kind: "desktop" });
  });
});

describe("networkOf", () => {
  it("shows an IPv4 address's /24, not the address", () => {
    expect(networkOf("203.0.113.57")).toBe("203.0.113.x");
    expect(networkOf("::ffff:198.51.100.4")).toBe("198.51.100.x");
    // …however the mapped form is spelled (the code review's low).
    expect(networkOf("::ffff:c000:201")).toBe("192.0.2.x");
  });

  it("shows an IPv6 address's /48, however it is spelled", () => {
    expect(networkOf("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1::/48");
    expect(networkOf("2001:0db8:0001:0000:0000:0000:0000:0001")).toBe("2001:db8:1::/48");
    expect(networkOf("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(networkOf("::1")).toBe("0:0:0::/48");
  });

  it("answers null for anything that is not an address", () => {
    for (const value of [null, undefined, "", "unknown", "300.1.1.1", "1.2.3", "2001:db8::1::2", "abc", "1:2:3:4:5:6:7:8:9", "g::1"]) {
      expect(networkOf(value), String(value)).toBeNull();
    }
    expect(networkOf("1".repeat(100))).toBeNull();
  });
});
