import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

import { reminderLabel } from "./reminder-label";

describe("reminderLabel — which `inbox.reminder.*` message draws a renewal reminder", () => {
  it("each reminder kind takes its own message and numbers", () => {
    expect(reminderLabel("expiration.asset_due", { days: 14, count: null })).toEqual({ key: "assetDue", days: 14 });
    expect(reminderLabel("expiration.agreement_ending", { days: 7, count: null })).toEqual({ key: "agreementEnding", days: 7 });
    expect(reminderLabel("expiration.logins_expiring", { days: 1, count: 3 })).toEqual({ key: "loginsExpiring", days: 1, count: 3 });
  });

  it("no numbers, a login row without its count, or any other kind → the generic kind label", () => {
    expect(reminderLabel("expiration.asset_due", null)).toBeNull();
    expect(reminderLabel("expiration.logins_expiring", { days: 7, count: null })).toBeNull();
    expect(reminderLabel("work_item.assigned", { days: 7, count: 1 })).toBeNull();
    expect(reminderLabel(null, { days: 7, count: 1 })).toBeNull();
  });

  it("every key it can name exists in both catalogues", () => {
    for (const key of ["assetDue", "agreementEnding", "loginsExpiring"] as const) {
      expect(en.inbox.reminder[key], key).toBeTruthy();
      expect(sv.inbox.reminder[key], key).toBeTruthy();
    }
  });
});
