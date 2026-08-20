import { describe, expect, it } from "vitest";

import {
  MODULES,
  PERMISSIONS,
  ROLE_TEMPLATES,
  permissionsForTemplate,
} from "./catalog";

describe("permission catalog (AUTHZ.md §3.1–§3.2, closed)", () => {
  it("holds exactly 96 codes, all unique (63 v1 + 17 work @ 2W + 16 time @ 2T — bumped deliberately 2026-08-20)", () => {
    expect(PERMISSIONS).toHaveLength(96);
    expect(new Set(PERMISSIONS.map((p) => p.code)).size).toBe(96);
  });

  it("the deprecated set is exactly issue:* — unseeded everywhere, rows kept (first §3.1 deprecation)", () => {
    const deprecated = PERMISSIONS.filter((p) => p.deprecated);
    expect(deprecated.map((p) => p.code).sort()).toEqual([
      "issue:comment",
      "issue:create",
      "issue:delete",
      "issue:edit",
      "issue:view",
    ]);
    for (const p of deprecated) expect(p.seeded, p.code).toEqual([]);
  });

  it("codes are resource:verb — colon namespace, never dots", () => {
    for (const perm of PERMISSIONS) {
      expect(perm.code).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
  });

  it("module is always one of the seven entitlement modules or core/portal", () => {
    for (const perm of PERMISSIONS) {
      expect(MODULES).toContain(perm.module);
    }
  });

  it("the ✦ requiresMfa set is exactly the §7.5 list", () => {
    const mfa = PERMISSIONS.filter((p) => p.requiresMfa).map((p) => p.code).sort();
    expect(mfa).toEqual(
      [
        "billing:manage",
        "continuity_box:configure",
        "continuity_box:edit",
        "continuity_box:veto",
        "continuity_box:view",
        "invoice:manage_series",
        "member:manage_roles",
        "role:edit",
        "settings:manage_modules",
        "tenant:export",
        // 2T — cost rates are salary-grade data (AUTHZ.md §7.5, SECURITY.md §9.7.4)
        "rate:view_cost",
        "rate:manage_cost",
      ].sort(),
    );
  });
});

describe("role templates (AUTHZ.md §3.3, B6 accepted 2026-08-08)", () => {
  it("owner is seeded with every non-deprecated code — no owner bypass exists anywhere", () => {
    const live = PERMISSIONS.filter((p) => !p.deprecated);
    expect(permissionsForTemplate("owner")).toHaveLength(live.length);
  });

  it("templateKey identities are canonical; CEO is only a display name", () => {
    expect(ROLE_TEMPLATES.map((t) => t.templateKey)).toEqual([
      "owner",
      "manager",
      "admin",
      "employee",
    ]);
    expect(ROLE_TEMPLATES.find((t) => t.templateKey === "owner")?.displayName).toBe("CEO");
  });

  it("managers cannot issue invoices; admins can (money-final sits back-office)", () => {
    const manager = permissionsForTemplate("manager").map((p) => p.code);
    const admin = permissionsForTemplate("admin").map((p) => p.code);
    for (const code of ["invoice:issue", "invoice:send", "invoice:record_payment", "invoice:credit"]) {
      expect(manager).not.toContain(code);
      expect(admin).toContain(code);
    }
  });

  it("employees have no invoice or contract permissions at all", () => {
    const employee = permissionsForTemplate("employee").map((p) => p.code);
    expect(employee.filter((c) => c.startsWith("invoice:"))).toEqual([]);
    expect(employee.filter((c) => c.startsWith("contract:"))).toEqual([]);
  });

  it("client:view_all is seeded on owner/manager/admin only (decision 5)", () => {
    const def = PERMISSIONS.find((p) => p.code === "client:view_all");
    expect(def?.seeded).toEqual(["owner", "manager", "admin"]);
  });

  it("only owner holds the highest-stakes codes", () => {
    for (const code of [
      "client:delete",
      "invoice:manage_series",
      "billing:manage",
      "settings:manage_modules",
      "tenant:export",
      "continuity_box:edit",
      "continuity_box:configure",
    ]) {
      const def = PERMISSIONS.find((p) => p.code === code);
      expect(def?.seeded, code).toEqual(["owner"]);
    }
  });
});
