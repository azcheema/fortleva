import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { VAULT_DEFAULTS, VAULT_SEALED_WAIT_DAYS_RANGE } from "@/preferences/config";

import { SEALED_REASON_MAX, SEALED_RULES, SEALED_UNSCHEDULED_HORIZON_DAYS, sealedAskLockKey } from "./sealed-rules";

/**
 * THE SEALED LAYER'S FIGURES ARE THE DATABASE'S TOO (slice 93): the
 * migration holds every one as a CHECK or in its guard, in hours, and the
 * application derives the state from the same figures. A figure changed on
 * one side only would let the two disagree about when an ask opens, lapses
 * or may be made again — so each is pinned to the SQL text here.
 */
const SQL = readFileSync(
  join(process.cwd(), "prisma", "migrations", "20261005220000_sealed_open_request", "migration.sql"),
  "utf8",
);

describe("the sealed layer's figures match migration 20261005220000", () => {
  it("opens 48 hours after a confirmation, for 7 days", () => {
    expect(SEALED_RULES.noticeHours).toBe(48);
    expect(SQL).toContain(`opens_at = confirmed_at + interval '${SEALED_RULES.noticeHours} hours'`);
    expect(SQL).toContain(`open_until = opens_at + interval '${SEALED_RULES.openDays * 24} hours'`);
  });

  it("lapses 30 days after the wait, and a denial cools for 30 days", () => {
    expect(SQL).toContain(`make_interval(hours => (wait_days + ${SEALED_RULES.confirmDays}) * 24)`);
    expect(SQL).toContain(`make_interval(hours => (OLD.wait_days + ${SEALED_RULES.confirmDays}) * 24)`);
    expect(SQL).toContain(`r.denied_at > at - interval '${SEALED_RULES.cooldownDays * 24} hours'`);
  });

  it("the wait is 7–60 days, 7 by default — the preference, the CHECK and the guard's fallback alike", () => {
    expect(VAULT_SEALED_WAIT_DAYS_RANGE).toEqual({ min: 7, max: 60 });
    expect(VAULT_DEFAULTS.sealedWaitDays).toBe(VAULT_SEALED_WAIT_DAYS_RANGE.min);
    expect(SQL).toContain(
      `CHECK (wait_days BETWEEN ${VAULT_SEALED_WAIT_DAYS_RANGE.min} AND ${VAULT_SEALED_WAIT_DAYS_RANGE.max})`,
    );
    expect(SQL).toContain(`expected := ${VAULT_DEFAULTS.sealedWaitDays};`);
    expect(SQL).toContain(`BETWEEN ${VAULT_SEALED_WAIT_DAYS_RANGE.min} AND ${VAULT_SEALED_WAIT_DAYS_RANGE.max} THEN`);
  });

  it("the job and the banner look back past the longest wait plus the confirmation's 30 days", () => {
    expect(SEALED_UNSCHEDULED_HORIZON_DAYS).toBeGreaterThan(VAULT_SEALED_WAIT_DAYS_RANGE.max + SEALED_RULES.confirmDays);
  });

  it("a reason, and a denial's reason, say at most 1000 characters", () => {
    expect(SQL).toContain(`char_length(reason) BETWEEN 1 AND ${SEALED_REASON_MAX}`);
    expect(SQL).toContain(`char_length(deny_reason) BETWEEN 1 AND ${SEALED_REASON_MAX}`);
  });

  it("the broker and the guard take one advisory lock key per client", () => {
    expect(sealedAskLockKey("t", "c")).toBe("sealed_open_request:t:c");
    expect(SQL).toContain(`hashtext('sealed_open_request:' || NEW.tenant_id || ':' || NEW.client_id)`);
    expect(SQL).toContain(`hashtext('sealed_open_request:' || OLD.tenant_id || ':' || OLD.client_id)`);
  });
});
