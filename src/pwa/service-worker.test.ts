import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { serviceWorkerSource } from "./service-worker";

/**
 * The worker run for real, in a fresh VM context, against a fake `self`: what it
 * shows for a push and where a tap goes (Phase 5 slice 106), and that the
 * Stage A rule still holds — a navigation is never answered from the worker.
 */

const ORIGIN = "https://app.example.test";
const ID = "0199c2a0-1234-7abc-8def-0123456789ab";

type Handler = (event: Record<string, unknown>) => void;

function loadWorker(windows: Array<{ url: string; focus: () => Promise<unknown>; navigate: (u: string) => Promise<unknown> }> = []) {
  const handlers = new Map<string, Handler>();
  const showNotification = vi.fn<(title: string, options: unknown) => Promise<undefined>>(async () => undefined);
  const openWindow = vi.fn(async () => null);
  const matchAll = vi.fn(async () => windows);
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    skipWaiting: () => undefined,
    registration: { showNotification },
    clients: { matchAll, openWindow, claim: async () => undefined },
  };
  runInNewContext(serviceWorkerSource("test"), { self, caches: {}, fetch: () => undefined, URL, console });
  /** Dispatch an event and wait for what it handed `waitUntil`. */
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> = Promise.resolve();
    handlers.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  };
  return { dispatch, showNotification, openWindow, matchAll, handlers };
}

const pushData = (value: unknown) => ({ json: () => value });
const badData = { json: () => JSON.parse("{not json") };

describe("the worker's push handler", () => {
  it("shows the payload's title and body, tagged by the notification, opening its own path", async () => {
    const w = loadWorker();
    await w.dispatch("push", {
      data: pushData({ v: 1, id: ID, title: "Fortleva", body: "A task was assigned to you", url: `/inbox/open/${ID}` }),
    });
    expect(w.showNotification).toHaveBeenCalledWith("Fortleva", {
      body: "A task was assigned to you",
      icon: "/icons/icon-192.png",
      data: { url: `/inbox/open/${ID}` },
      tag: ID,
    });
  });

  it("still shows a notification for an unreadable or missing payload — never nothing", async () => {
    for (const data of [badData, null, pushData("a string"), pushData(42)]) {
      const w = loadWorker();
      await w.dispatch("push", { data });
      expect(w.showNotification).toHaveBeenCalledWith("Fortleva", {
        body: "",
        icon: "/icons/icon-192.png",
        data: { url: "/inbox" },
      });
    }
  });

  it("opens the inbox for any target that is not exactly /inbox/open/<uuid>", async () => {
    for (const url of [
      "https://evil.example/inbox/open/" + ID,
      "//evil.example/x",
      `/inbox/open/${ID}/../../settings`,
      `/inbox/open/${ID}?x=1`,
      "/settings/members",
      "javascript:alert(1)",
      `/INBOX/OPEN/${ID}`,
    ]) {
      const w = loadWorker();
      await w.dispatch("push", { data: pushData({ id: ID, title: "t", body: "b", url }) });
      expect(w.showNotification.mock.calls[0]![1]).toMatchObject({ data: { url: "/inbox" } });
    }
  });

  it("drops a title or body over 200 characters and a tag that is not a notification id", async () => {
    const w = loadWorker();
    await w.dispatch("push", { data: pushData({ id: "not-an-id", title: "x".repeat(201), body: "y".repeat(201), url: "/inbox" }) });
    expect(w.showNotification).toHaveBeenCalledWith("Fortleva", { body: "", icon: "/icons/icon-192.png", data: { url: "/inbox" } });
  });
});

describe("the worker's notificationclick handler", () => {
  const click = (url: unknown) => ({ notification: { close: vi.fn(), data: { url } } });

  it("focuses and navigates a window it controls, on its own origin", async () => {
    const navigate = vi.fn(async () => undefined);
    const focus = vi.fn(async () => undefined);
    const w = loadWorker([{ url: `${ORIGIN}/home`, focus, navigate }]);
    const event = click(`/inbox/open/${ID}`);
    await w.dispatch("notificationclick", event);
    expect(event.notification.close).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/inbox/open/${ID}`);
    expect(w.openWindow).not.toHaveBeenCalled();
  });

  it("opens a new window when none is open, and never leaves the origin", async () => {
    const w = loadWorker();
    await w.dispatch("notificationclick", click("https://evil.example/"));
    expect(w.openWindow).toHaveBeenCalledWith(`${ORIGIN}/inbox`);
  });

  it("opens a new window when the open one cannot be navigated", async () => {
    const w = loadWorker([{ url: `${ORIGIN}/home`, focus: async () => undefined, navigate: async () => Promise.reject(new TypeError("x")) }]);
    await w.dispatch("notificationclick", click(`/inbox/open/${ID}`));
    expect(w.openWindow).toHaveBeenCalledWith(`${ORIGIN}/inbox/open/${ID}`);
  });
});

describe("Stage A still holds", () => {
  it("never answers a navigation or an /api/* request from the worker", () => {
    const w = loadWorker();
    for (const url of [`${ORIGIN}/home`, `${ORIGIN}/api/jobs/run`, `${ORIGIN}/inbox/open/${ID}`]) {
      const respondWith = vi.fn();
      w.handlers.get("fetch")!({ request: { method: "GET", url }, respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
  });
});
