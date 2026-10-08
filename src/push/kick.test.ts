import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE KICK (slice 106; C74 (h)): only inside a request, only the ids it was
 * given, at most two at once. `next/server`'s `after` and the drain are
 * replaced, so this runs the rule itself — the dbtest can only watch a row.
 */

const after = vi.fn<(task: () => Promise<void>) => void>();
const deliverPushes = vi.fn<(tenantId: string, opts: { ids: string[]; budgetMs: number }) => Promise<unknown>>();

vi.mock("next/server", () => ({ after: (task: () => Promise<void>) => after(task) }));
vi.mock("@/jobs/push", () => ({ deliverPushes: (t: string, o: { ids: string[]; budgetMs: number }) => deliverPushes(t, o) }));
vi.mock("@/config", async (original) => ({ ...(await original<typeof import("@/config")>()), pushTransportKind: "dev" }));

const { kickPushes } = await import("./kick");

beforeEach(() => {
  after.mockReset();
  deliverPushes.mockReset();
});

describe("kickPushes", () => {
  it("does nothing outside a request — after() throws there, and nothing is started detached", () => {
    after.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });
    expect(() => kickPushes("t1", ["n1"])).not.toThrow();
    expect(deliverPushes).not.toHaveBeenCalled();
  });

  it("inside a request, delivers exactly the ids it was given, once the response has gone", async () => {
    const tasks: Array<() => Promise<void>> = [];
    after.mockImplementation((task) => tasks.push(task));
    deliverPushes.mockResolvedValue({});
    const ids = ["n1", "n2"];
    kickPushes("t1", ids);
    ids.push("n3"); // the caller's array changing later changes nothing
    expect(deliverPushes).not.toHaveBeenCalled();
    await tasks[0]!();
    expect(deliverPushes).toHaveBeenCalledWith("t1", { ids: ["n1", "n2"], budgetMs: 15_000 });
  });

  it("schedules nothing for no ids", () => {
    kickPushes("t1", []);
    expect(after).not.toHaveBeenCalled();
  });

  it("runs at most two at once in a process; the third waits its turn, and a failure frees its place", async () => {
    const tasks: Array<() => Promise<void>> = [];
    after.mockImplementation((task) => tasks.push(task));
    const releases: Array<(v?: unknown) => void> = [];
    deliverPushes.mockImplementation(
      (t) =>
        new Promise((resolve, reject) => {
          releases.push(t === "fail" ? () => reject(new Error("boom")) : resolve);
        }),
    );
    kickPushes("fail", ["a"]);
    kickPushes("t2", ["b"]);
    kickPushes("t3", ["c"]);
    const running = tasks.map((task) => task());
    await vi.waitFor(() => expect(deliverPushes).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deliverPushes).toHaveBeenCalledTimes(2);
    releases[0]!(); // the failing one ends — logged, its place handed on
    await vi.waitFor(() => expect(deliverPushes).toHaveBeenCalledTimes(3));
    releases[1]!();
    releases[2]!();
    await Promise.all(running);
  });
});
