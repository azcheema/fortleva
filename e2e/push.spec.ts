import { createDecipheriv, createECDH, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { SLOW, createOwnTask, deleteOwnTasks, picker, pressUntil, rail, searchField } from "./fixtures/keys";
import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * PHONE AND BROWSER NOTIFICATIONS, END TO END (Phase 5 slice 106; founder
 * decision C74). What only a browser and the real server together can show:
 * Settings → Notifications turns THIS device on through the service worker;
 * the owner handing the employee a task makes the SERVER push at once — the
 * kick after the request, encrypted for the device, signed with the server's
 * key — and the push says what happened and names nothing; the tap's link
 * opens the task as the employee; turning the device off removes it.
 *
 * WHAT IS STUBBED, AND WHY: headless Chromium cannot reach a real push
 * service, so the page's `PushManager` hands out a subscription whose keys
 * THIS test made (`addInitScript`) — everything after that is real. The
 * harness runs the server with `PUSH_TRANSPORT=dev` and a throwaway VAPID pair
 * (`playwright.config.ts`), so each push lands in `.dev-outbox/push.jsonl`,
 * which the test decrypts with the device's private key exactly as a browser
 * would. The worker is ALLOWED here (the harness blocks it elsewhere —
 * `pwa.spec.ts` is the other opt-in); nothing here uses `page.route`.
 */

let seed!: E2ESeed;
test.beforeAll(() => {
  seed = requireSeed();
});

test.use({ serviceWorkers: "allow" });

const OUTBOX = join(process.cwd(), ".dev-outbox", "push.jsonl");

type PushLine = { endpoint: string; headers: Record<string, string>; body: string };

const pushesTo = (endpoint: string): PushLine[] =>
  existsSync(OUTBOX)
    ? readFileSync(OUTBOX, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as PushLine)
        .filter((l) => l.endpoint === endpoint)
    : [];

/** The device's keys, made here — and its side of RFC 8291 to read what it receives. */
function device() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/e2e-push-${randomUUID()}`,
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: auth.toString("base64url"),
    read(bodyB64u: string): Record<string, unknown> {
      const body = Buffer.from(bodyB64u, "base64url");
      const salt = body.subarray(0, 16);
      const idlen = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idlen);
      const record = body.subarray(21 + idlen);
      const secret = ecdh.computeSecret(asPublic);
      const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]);
      const ikm = Buffer.from(hkdfSync("sha256", secret, auth, keyInfo, 32));
      const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const d = createDecipheriv("aes-128-gcm", cek, nonce);
      d.setAuthTag(record.subarray(record.length - 16));
      const padded = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
      return JSON.parse(padded.subarray(0, padded.lastIndexOf(0x02)).toString("utf8")) as Record<string, unknown>;
    },
  };
}

/**
 * The page's push machinery, stubbed BEFORE any script runs: a subscription
 * carrying the test's keys and the server key the page asked with, kept in
 * localStorage so it survives navigations (as a real one does), and a
 * notification permission that the button's press grants.
 */
function stubPush(keys: { endpoint: string; p256dh: string; auth: string }) {
  const KEY = "flv-e2e-push";
  const PERM = "flv-e2e-perm";
  const read = (k: string): string | null => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const write = (k: string, v: string | null): void => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      // about:blank has no storage
    }
  };
  const toB64u = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const fromB64u = (s: string): Uint8Array => {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  };
  const make = (serverKey: string) => ({
    endpoint: keys.endpoint,
    expirationTime: null,
    options: { applicationServerKey: fromB64u(serverKey).buffer, userVisibleOnly: true },
    toJSON: () => ({ endpoint: keys.endpoint, expirationTime: null, keys: { p256dh: keys.p256dh, auth: keys.auth } }),
    unsubscribe: async () => {
      write(KEY, null);
      return true;
    },
  });
  if (typeof PushManager === "undefined" || typeof Notification === "undefined") return;
  PushManager.prototype.getSubscription = async function getSubscription() {
    const saved = read(KEY);
    return (saved === null ? null : make(saved)) as unknown as PushSubscription;
  };
  PushManager.prototype.subscribe = async function subscribe(options?: PushSubscriptionOptionsInit) {
    const raw = options?.applicationServerKey;
    const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array((raw as ArrayBufferView).buffer);
    const serverKey = toB64u(bytes);
    write(KEY, serverKey);
    return make(serverKey) as unknown as PushSubscription;
  };
  Object.defineProperty(Notification, "permission", { configurable: true, get: () => read(PERM) ?? "default" });
  Notification.requestPermission = async () => {
    write(PERM, "granted");
    return "granted";
  };
}

async function signInAsEmployee(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(seed.employeeEmail);
  await page.locator("#password").fill(seed.employeePassword);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL("**/home", { timeout: 30_000 * SLOW });
}

const created: string[] = [];
test.afterEach(async ({ page }) => {
  await deleteOwnTasks(page, seed, created.splice(0));
});

test("a task handed to the employee buzzes their device at once — what happened, no name — and the tap opens it", async ({
  page,
  browser,
}) => {
  const phone = device();
  const employee = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    storageState: { cookies: [], origins: [] },
    serviceWorkers: "allow",
    locale: "en-US",
  });
  try {
    await employee.addInitScript(stubPush, { endpoint: phone.endpoint, p256dh: phone.p256dh, auth: phone.auth });
    const ep = await employee.newPage();
    await signInAsEmployee(ep);

    // Turn this device on (C74 (f): Settings → Notifications, the only place).
    await ep.goto("/settings/notifications");
    const state = ep.getByTestId("push-device-state");
    await expect(state).toHaveAttribute("data-state", "off", { timeout: 20_000 * SLOW });
    await ep.getByTestId("push-turn-on").click();
    await expect(state).toHaveAttribute("data-state", "on", { timeout: 20_000 * SLOW });
    const mine = ep.getByTestId("push-device").filter({ hasText: "This device" });
    await expect(mine).toHaveCount(1, { timeout: 20_000 * SLOW });
    // Still on after a reload: the server's row and the browser's subscription agree.
    await ep.reload();
    await expect(state).toHaveAttribute("data-state", "on", { timeout: 20_000 * SLOW });

    // The owner hands the employee a task.
    expect(pushesTo(phone.endpoint)).toHaveLength(0);
    const task = await createOwnTask(page, seed, "Push handover", created);
    await pressUntil(page, "a", picker(page));
    await expect(searchField(page)).toBeFocused();
    await page.keyboard.type("Employee");
    await expect(picker(page).getByRole("option", { name: /E2E Employee/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(rail(page).getByTestId("item-assignee").locator("[data-value]")).toHaveText("E2E Employee");

    // At once (C74 (h)): the kick after the request, not a two-minute wait.
    await expect.poll(() => pushesTo(phone.endpoint).length, { timeout: 30_000 * SLOW }).toBe(1);
    const [push] = pushesTo(phone.endpoint);
    expect(push!.headers["Authorization"]).toBeUndefined(); // the dev outbox never keeps our signature
    expect(Number(push!.headers["TTL"])).toBeGreaterThan(0);
    const payload = phone.read(push!.body);
    expect(payload).toMatchObject({ v: 1, title: "Fortleva", body: "A task was assigned to you" });
    expect(String(payload["url"])).toMatch(/^\/inbox\/open\/[0-9a-f-]{36}$/);
    // What happened, never a name (C74 (a)): not the task, not who did it.
    const said = JSON.stringify(payload);
    expect(said).not.toContain(task.title);
    expect(said).not.toContain(task.key);
    expect(said).not.toContain("E2E Owner");

    // The tap's link, as the employee: it opens the task, and marks the notification read.
    await ep.goto(String(payload["url"]));
    await ep.waitForURL((url) => !url.pathname.startsWith("/inbox/open/"), { timeout: 30_000 * SLOW });
    expect(new URL(ep.url()).pathname).not.toBe("/inbox");
    await ep.goto("/inbox");
    await expect(ep.locator(`[data-notification-id="${String(payload["id"])}"]`)).toHaveCount(0, { timeout: 20_000 * SLOW });

    // Turn this device off: its row is gone from the list.
    await ep.goto("/settings/notifications");
    await expect(state).toHaveAttribute("data-state", "on", { timeout: 20_000 * SLOW });
    await ep.getByTestId("push-turn-off").click();
    await expect(state).toHaveAttribute("data-state", "off", { timeout: 20_000 * SLOW });
    await expect(mine).toHaveCount(0);
  } finally {
    await employee.close();
  }
});
