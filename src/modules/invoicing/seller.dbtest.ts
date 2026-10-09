import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { actorFor, noMfa, setupTenant } from "@/members/dbtest-fixture";
import { INVOICE_DETAILS_CHANGED_MAIL } from "@/notify/invoice-details-mail-key";

import { readInvoiceSettings, updateCompanyDetails, updateDefaultPaymentTerms, updatePaymentDetails } from "./seller";

/**
 * WHAT THE WORKSPACE'S INVOICES SAY ABOUT IT, against the real database
 * (Phase 4 slice 107; founder decisions C75 (h), (i), (j)):
 *   - both protected cards — the company details and the payment details (bank
 *     columns + the note on every invoice) — need `settings:edit` AND a second
 *     factor no older than a MINUTE (the code typed in the form; the ✦ window's
 *     fifteen minutes would admit the code typed at sign-in), and mail every
 *     active owner in the same transaction;
 *   - the company trail names FIELDS, never values (an org. number can be a
 *     personnummer); the payment trail names fields, the bank values' last four
 *     and the note's text; "who and when" read back for the page;
 *   - the bank columns are stored v2-encrypted;
 *   - the database's backstop on the runtime role: only an active member
 *     holding `settings:edit` changes any of the fifteen columns.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
const ctxOf = (memberId: string, fresh = true) => ({
  tenantId: f.tenantId,
  actor: fresh ? actorFor(memberId) : noMfa(memberId),
});
/** A factor verified `seconds` ago — the code typed in the form is a few seconds old; the sign-in's, minutes. */
const agedCtx = (memberId: string, seconds: number) => ({
  tenantId: f.tenantId,
  actor: { memberId, mfa: { enrolled: true, verifiedAt: new Date(Date.now() - seconds * 1000) } } satisfies MemberActor,
});

const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

const raw = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    return text.includes("TENANT_INVOICE_DETAILS_GUARD") ? "TENANT_INVOICE_DETAILS_GUARD" : `unexpected: ${text.slice(0, 200)}`;
  }
};

const mails = () => f.platform.emailOutbox.count({ where: { tenantId: f.tenantId, kind: INVOICE_DETAILS_CHANGED_MAIL } });

beforeAll(async () => {
  f = await setupTenant("invs");
}, 120_000);

afterAll(async () => {
  if (!f) return;
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 120_000);

describe("the company card (C75 (j))", () => {
  it("is read by settings:view; written, normalised, by settings:edit with a code a minute old at most", async () => {
    expect(await outcome(readInvoiceSettings(ctxOf(f.seats.employee.memberId)))).toBe("FORBIDDEN");
    const before = await readInvoiceSettings(ctxOf(f.seats.manager.memberId));
    expect(before.canEdit).toBe(false);
    expect(before.missing).toEqual(["legalName", "orgNr", "vatNumber", "address", "payment"]);
    expect(await outcome(updateCompanyDetails(ctxOf(f.seats.manager.memberId), { legalName: "X" }))).toBe("FORBIDDEN");
    // No factor, or one five minutes old (inside the ✦ window, past this one).
    expect(await outcome(updateCompanyDetails(ctxOf(f.seats.admin.memberId, false), { legalName: "X" }))).toBe("MFA_REQUIRED");
    expect(await outcome(updateCompanyDetails(agedCtx(f.seats.admin.memberId, 300), { legalName: "X" }))).toBe("MFA_REQUIRED");
    expect(await mails()).toBe(0);

    const changed = await updateCompanyDetails(agedCtx(f.seats.admin.memberId, 5), {
      legalName: " Naxtest AB ",
      orgNr: "5560125790",
      vatNumber: "se 556012-5790 01",
      fSkattApproved: true,
      addressLine1: "Storgatan 1",
      postalCode: "111 22",
      city: "Stockholm",
      countryCode: "se",
    });
    expect(changed).toEqual(["legalName", "orgNr", "vatNumber", "fSkattApproved", "addressLine1", "postalCode", "city", "countryCode"]);
    const after = await readInvoiceSettings(ctxOf(f.seats.admin.memberId));
    expect(after.canEdit).toBe(true);
    expect(after.company).toMatchObject({
      legalName: "Naxtest AB",
      orgNr: "556012-5790",
      vatNumber: "SE556012579001",
      fSkattApproved: true,
      countryCode: "SE",
    });
    // An aktiebolag's number: its registered office is now missing too.
    expect(after.missing).toEqual(["seat", "payment"]);
    expect(after.companyChanged?.by).toMatch(/^admin-invs-/);
    const rows = await f.audits("invoice_settings.company_changed");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain("556012");
    // Every owner is told, in the same transaction.
    const mail = await f.platform.emailOutbox.findMany({
      where: { tenantId: f.tenantId, kind: INVOICE_DETAILS_CHANGED_MAIL },
      select: { receiverId: true },
    });
    expect(mail.map((m) => m.receiverId)).toEqual([f.seats.owner.memberId]);
    // Unchanged values write nothing and tell nobody.
    expect(await updateCompanyDetails(ctxOf(f.seats.admin.memberId), { legalName: "Naxtest AB" })).toEqual([]);
    expect(await f.audits("invoice_settings.company_changed")).toHaveLength(1);
    expect(await mails()).toBe(1);
  });

  it("refuses a mistyped org. number or VAT number", async () => {
    expect(await outcome(updateCompanyDetails(ctxOf(f.seats.admin.memberId), { orgNr: "556012-5791" }))).toBe("ORG_NR_INVALID");
    expect(await outcome(updateCompanyDetails(ctxOf(f.seats.admin.memberId), { vatNumber: "SE556012579101" }))).toBe(
      "VAT_NUMBER_INVALID",
    );
  });
});

describe("the payment details (C75 (h), (i))", () => {
  it("need settings:edit and a code a minute old at most", async () => {
    expect(await outcome(updatePaymentDetails(ctxOf(f.seats.admin.memberId, false), { bankgiro: "5050-1055" }))).toBe(
      "MFA_REQUIRED",
    );
    expect(await outcome(updatePaymentDetails(agedCtx(f.seats.admin.memberId, 120), { bankgiro: "5050-1055" }))).toBe(
      "MFA_REQUIRED",
    );
    expect(await outcome(updatePaymentDetails(ctxOf(f.seats.manager.memberId), { bankgiro: "5050-1055" }))).toBe("FORBIDDEN");
  });

  it("are stored encrypted, mail every owner, and leave a trail with the last four and the note", async () => {
    const at = new Date();
    const mailsBefore = await mails();
    const changed = await updatePaymentDetails(ctxOf(f.seats.admin.memberId), {
      bankgiro: "50501055",
      iban: "se45 5000 0000 0583 9825 7466",
      footerNote: "Dröjsmålsränta enligt räntelagen.",
    });
    expect(changed).toEqual(["bankgiro", "iban", "footerNote"]);
    const stored = await f.platform.tenant.findUniqueOrThrow({
      where: { id: f.tenantId },
      select: { bankgiro: true, iban: true, invoiceFooterNote: true },
    });
    expect(stored.bankgiro).toMatch(/^v2\./);
    expect(stored.iban).toMatch(/^v2\./);
    expect(stored.bankgiro).not.toContain("5050");
    expect(stored.invoiceFooterNote).toBe("Dröjsmålsränta enligt räntelagen.");

    const read = await readInvoiceSettings(ctxOf(f.seats.manager.memberId));
    expect(read.payment).toMatchObject({ bankgiro: "5050-1055", iban: "SE45 5000 0000 0583 9825 7466", plusgiro: null });
    expect(read.missing).toEqual(["seat"]);
    expect(read.paymentChanged?.by).toMatch(/^admin-invs-/);
    expect(read.paymentChanged!.at.getTime()).toBeGreaterThanOrEqual(at.getTime() - 60_000);

    const trail = await f.audits("invoice_settings.payment_details_changed");
    expect(trail).toHaveLength(1);
    expect(trail[0]!.metadata).toEqual({
      fields: ["bankgiro", "iban", "footerNote"],
      lastFour: { bankgiro: "1055", iban: "7466" },
      footerNote: "Dröjsmålsränta enligt räntelagen.",
    });
    expect(await mails()).toBe(mailsBefore + 1);

    // The same values again change nothing, mail nobody, audit nothing.
    expect(await updatePaymentDetails(ctxOf(f.seats.admin.memberId), { bankgiro: "5050-1055" })).toEqual([]);
    expect(await f.audits("invoice_settings.payment_details_changed")).toHaveLength(1);
    expect(await mails()).toBe(mailsBefore + 1);

    // Blank removes one.
    expect(await updatePaymentDetails(ctxOf(f.seats.admin.memberId), { iban: "" })).toEqual(["iban"]);
    expect((await readInvoiceSettings(ctxOf(f.seats.admin.memberId))).payment.iban).toBeNull();
  });

  it("refuse what fails its check digit", async () => {
    expect(await outcome(updatePaymentDetails(ctxOf(f.seats.admin.memberId), { iban: "SE4550000000058398257467" }))).toBe(
      "IBAN_INVALID",
    );
    expect(await outcome(updatePaymentDetails(ctxOf(f.seats.admin.memberId), { bankgiro: "5050-1056" }))).toBe(
      "BANKGIRO_INVALID",
    );
  });
});

describe("THE DATABASE'S BACKSTOP (migrations 20261009120000, 20261009150000)", () => {
  type P = Parameters<typeof withTenant>[1];
  const update = (principal: P, set: "plusgiro" | "note" | "city" | "fskatt") =>
    raw(
      withTenant(f.tenantId, principal, (tx) =>
        set === "plusgiro"
          ? tx.$executeRaw`UPDATE tenant SET plusgiro = 'v2.x' WHERE id = ${f.tenantId}`
          : set === "note"
            ? tx.$executeRaw`UPDATE tenant SET invoice_footer_note = 'Pay to SE00 elsewhere' WHERE id = ${f.tenantId}`
            : set === "city"
              ? tx.$executeRaw`UPDATE tenant SET city = 'Pay only to BG 123-4567' WHERE id = ${f.tenantId}`
              : tx.$executeRaw`UPDATE tenant SET f_skatt_approved = NOT f_skatt_approved WHERE id = ${f.tenantId}`,
      ),
    );

  it("on the runtime role, only an active member holding settings:edit changes any of the fifteen", async () => {
    const manager: P = { type: "member", id: f.seats.manager.memberId };
    const system: P = { type: "system" };
    for (const set of ["plusgiro", "note", "city", "fskatt"] as const) {
      expect(await update(manager, set), set).toBe("TENANT_INVOICE_DETAILS_GUARD");
      expect(await update(system, set), set).toBe("TENANT_INVOICE_DETAILS_GUARD");
    }
    // A member who may (the app adds the code and the owners' mail).
    expect(await update({ type: "member", id: f.seats.admin.memberId }, "plusgiro")).toBe("ok");
    // Any other column is not judged at all.
    expect(
      await raw(
        withTenant(f.tenantId, system, (tx) =>
          tx.$executeRaw`UPDATE tenant SET storage_used_bytes = storage_used_bytes WHERE id = ${f.tenantId}`,
        ),
      ),
    ).toBe("ok");
    await f.platform.tenant.update({ where: { id: f.tenantId }, data: { plusgiro: null } });
  });
});

describe("the default payment terms", () => {
  it("are whole days within range; blank goes back to the default", async () => {
    expect(await updateDefaultPaymentTerms(ctxOf(f.seats.admin.memberId), "20")).toBe(true);
    expect((await readInvoiceSettings(ctxOf(f.seats.admin.memberId))).paymentTermsDays).toBe(20);
    expect(await updateDefaultPaymentTerms(ctxOf(f.seats.admin.memberId), "20")).toBe(false);
    expect(await outcome(updateDefaultPaymentTerms(ctxOf(f.seats.admin.memberId), "200"))).toBe("INVALID_INPUT");
    expect(await updateDefaultPaymentTerms(ctxOf(f.seats.admin.memberId), "")).toBe(true);
    expect((await readInvoiceSettings(ctxOf(f.seats.admin.memberId))).paymentTermsDays).toBe(30);
  });
});
