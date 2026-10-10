import { describe, expect, it } from "vitest";

import {
  MODULES,
  PERMISSIONS,
  ROLE_TEMPLATES,
  permissionsForTemplate,
} from "./catalog";

describe("permission catalog (AUTHZ.md §3.1–§3.2, closed)", () => {
  it("holds exactly 114 codes, all unique (63 v1 + 17 work @ 2W + 16 time @ 2T + 1 work @ 2W-R + 1 portal @ P3 + 1 work @ P3 slice 6b + 5 vault @ 3V slice 1 + 1 core @ slice 84 + 3 vault @ slice 87 + 1 vault @ slice 90 + 1 vault @ slice 91 + 1 vault @ slice 92 + 1 vault @ slice 95 + 1 invoicing + 1 time @ slice 110 — bumped deliberately 2026-10-10)", () => {
    expect(PERMISSIONS).toHaveLength(114);
    expect(new Set(PERMISSIONS.map((p) => p.code)).size).toBe(114);
  });

  it("the hours-to-invoice codes are C A and never ✦ (slice 110, C80; AUTHZ.md §3.2)", () => {
    for (const code of ["invoice:generate_from_time", "time:write_off"]) {
      const def = PERMISSIONS.find((p) => p.code === code);
      expect(def?.seeded, code).toEqual(["owner", "admin"]);
      expect(def?.requiresMfa, code).toBe(false);
    }
    expect(PERMISSIONS.find((p) => p.code === "invoice:generate_from_time")?.module).toBe("invoicing");
    expect(PERMISSIONS.find((p) => p.code === "time:write_off")?.module).toBe("time");
  });

  it("credential:export is vault-module, ✦, and the owner's alone (slice 95, C63; AUTHZ.md §3.2)", () => {
    const def = PERMISSIONS.find((p) => p.code === "credential:export");
    expect(def?.seeded).toEqual(["owner"]);
    expect(def?.requiresMfa).toBe(true);
    expect(def?.module).toBe("vault");
  });

  it("credential:unseal is vault-module, ✦, and the owner's alone (slice 92, C52 (e), C60 (b))", () => {
    const def = PERMISSIONS.find((p) => p.code === "credential:unseal");
    expect(def?.seeded).toEqual(["owner"]);
    expect(def?.requiresMfa).toBe(true);
    expect(def?.module).toBe("vault");
  });

  it("credential:change_visibility is vault-module, ✦, and seeded C A — never a manager or employee (slice 91)", () => {
    const def = PERMISSIONS.find((p) => p.code === "credential:change_visibility");
    expect(def?.seeded).toEqual(["owner", "admin"]);
    expect(def?.requiresMfa).toBe(true);
    expect(def?.module).toBe("vault");
  });

  it("credential:share is vault-module, ✦, and seeded C M A — never the employee template (slice 90)", () => {
    const def = PERMISSIONS.find((p) => p.code === "credential:share");
    expect(def?.seeded).toEqual(["owner", "manager", "admin"]);
    expect(def?.requiresMfa).toBe(true);
    expect(def?.module).toBe("vault");
  });

  it("the asset codes are vault-module, never ✦, and seeded C M A E / C M A / C M (slice 87)", () => {
    const seeded = (code: string) => PERMISSIONS.find((p) => p.code === code);
    expect(seeded("asset:view")?.seeded).toEqual(["owner", "manager", "admin", "employee"]);
    expect(seeded("asset:manage")?.seeded).toEqual(["owner", "manager", "admin"]);
    expect(seeded("asset:delete")?.seeded).toEqual(["owner", "manager"]);
    for (const code of ["asset:view", "asset:manage", "asset:delete"]) {
      expect(seeded(code)?.module, code).toBe("vault");
      expect(seeded(code)?.requiresMfa, code).toBe(false);
    }
  });

  it("member:reset_two_factor is the owner's alone, behind a fresh factor (slice 84, C50)", () => {
    const def = PERMISSIONS.find((p) => p.code === "member:reset_two_factor");
    expect(def?.seeded).toEqual(["owner"]);
    expect(def?.requiresMfa).toBe(true);
    expect(def?.module).toBe("core");
  });

  it("credential:reveal is seeded C M A, never on the employee template (decision 13, CP4)", () => {
    const def = PERMISSIONS.find((p) => p.code === "credential:reveal");
    expect(def?.seeded).toEqual(["owner", "manager", "admin"]);
    expect(def?.requiresMfa).toBe(true);
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
        // 3V slice 1 — reveal moves plaintext (decision 13; AUTHZ.md §7.5)
        "credential:reveal",
        // 3V slice 90 — a share link hands a secret to someone outside (CP4: always step up)
        "credential:share",
        // 3V slice 91 — showing a login to a client (CP4: always step up)
        "credential:change_visibility",
        // 3V slice 92 — unsealing takes a client's right to ask away; an owner's act (C52 (e))
        "credential:unseal",
        // 3V slice 95 — a file of every secret in plain text (CP4: always step up; C63)
        "credential:export",
        // slice 84 — puts a teammate's account back on the password alone (C50)
        "member:reset_two_factor",
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
