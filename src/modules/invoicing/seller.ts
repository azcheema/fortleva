import { record } from "@/audit/record";
import { requireRecentMfa, resolvePermissions, type MemberActor } from "@/authz/authorize";
import { decryptFieldV2, encryptFieldV2 } from "@/crypto/field-encryption";
import { withTenant, type TenantDb } from "@/db";
import { hasAccess, requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { INVOICE_DETAILS_CHANGED_MAIL } from "@/notify/invoice-details-mail-key";

import {
  FOOTER_NOTE_MAX,
  normalizeBankgiro,
  normalizeBic,
  normalizeCountryCode,
  normalizeIban,
  normalizeOrgNr,
  normalizePaymentTerms,
  normalizePlusgiro,
  normalizeSeVatNumber,
  PAYMENT_TERMS_DEFAULT,
  SELLER_TEXT_MAX,
  textOrNull,
} from "./seller-fields";
import { missingForIssue } from "./issue-check";
import { readNumbering, type Numbering } from "./series";

/**
 * WHAT THE WORKSPACE'S INVOICES SAY ABOUT IT (Phase 4 slice 107) — Settings →
 * Invoicing. Two protected cards and one plain value:
 *
 *   - THE COMPANY (legal name, org. number, VAT number, registered office,
 *     F-tax approval, address) and THE PAYMENT DETAILS (Bankgiro, PlusGiro,
 *     IBAN, BIC, and the note printed on every invoice) are printed on every
 *     invoice, and any of them could tell a client to pay someone else — so
 *     changing them takes `settings:edit` AND the member's authenticator code
 *     typed IN THE FORM (founder decisions C75 (h), (i), (j); the window is
 *     `INVOICE_DETAILS_STEP_UP_MINUTES` — the ✦ window would accept the code
 *     typed at sign-in, the security review's finding), and every ACTIVE
 *     owner is mailed in the same transaction, whatever their email level (a
 *     security notice, the reply address's rule, C68 (i)); the mail is a
 *     link, never the details (ARC-09); the page it opens says who changed
 *     them and when, from the audit trail. The database holds a backstop: on
 *     the runtime role only an active member holding `settings:edit` changes
 *     any of the fifteen columns (`tenant_payment_details_guard`, migrations
 *     20261009120000 and 20261009150000).
 *   - The bank columns are stored v2-encrypted under the tenant's key, the
 *     AAD naming the tenant row and the column (DATA_MODEL §4), and read as
 *     v2 only: a v1 ciphertext has no AAD and these columns never had a v1
 *     writer, so one found here reads as unset. They are shown in plain text
 *     to `settings:view` — printed on every invoice, they are no secret from
 *     the people who send them.
 *   - THE DEFAULT PAYMENT TERMS: `settings:edit`; a `TenantPreference` row.
 *
 * AUDIT: `invoice_settings.company_changed` names the FIELDS, never the values
 * — an org. number can be a sole trader's personnummer (DATA_MODEL §4).
 * `invoice_settings.payment_details_changed` names the fields, each bank
 * field's new value's LAST FOUR characters (enough to say later where money
 * pointed, not enough to lift an account) and the note's new text — the
 * workspace's own words, printed on every invoice, so "what did the note say
 * in March" has an answer (the security review's nit). The terms write
 * `preference.changed` with the key, as every preference does.
 */

export type InvoicingCtx = { readonly tenantId: string; readonly actor: MemberActor };

const memberPrincipal = (ctx: InvoicingCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

/**
 * How recent the second factor must be to change what the invoices say: the
 * code typed in the form, verified by the action seconds before — the vault
 * export's window (`EXPORT_STEP_UP_MINUTES`).
 */
export const INVOICE_DETAILS_STEP_UP_MINUTES = 1;

export const PAYMENT_TERMS_PREF_KEY = "invoice.paymentTermsDays";

export const COMPANY_FIELDS = [
  "legalName",
  "orgNr",
  "vatNumber",
  "seat",
  "fSkattApproved",
  "addressLine1",
  "addressLine2",
  "postalCode",
  "city",
  "countryCode",
] as const;
export type CompanyField = (typeof COMPANY_FIELDS)[number];

export const BANK_FIELDS = ["bankgiro", "plusgiro", "iban", "bic"] as const;
export type BankField = (typeof BANK_FIELDS)[number];

export const PAYMENT_FIELDS = [...BANK_FIELDS, "footerNote"] as const;
export type PaymentField = (typeof PAYMENT_FIELDS)[number];

export type CompanyDetails = {
  readonly legalName: string | null;
  readonly orgNr: string | null;
  readonly vatNumber: string | null;
  readonly seat: string | null;
  readonly fSkattApproved: boolean;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly postalCode: string | null;
  readonly city: string | null;
  readonly countryCode: string | null;
};

export type PaymentDetails = Readonly<Record<PaymentField, string | null>>;

/** What issuing refuses without — named on the settings page and in the issue dialog. */
export type MissingDetail = "legalName" | "orgNr" | "vatNumber" | "seat" | "address" | "payment" | "paymentUnreadable" | "numbering";

type Changed = { readonly by: string | null; readonly at: Date } | null;

export type InvoiceSettings = {
  readonly company: CompanyDetails;
  readonly payment: PaymentDetails;
  readonly paymentTermsDays: number;
  readonly missing: readonly MissingDetail[];
  /** Who last changed each protected card, and when — the owners' mail links here. */
  readonly companyChanged: Changed;
  readonly paymentChanged: Changed;
  /** `settings:edit` on all four gates. */
  readonly canEdit: boolean;
  /** The workspace's invoice numbers (slice 108); null before a first number is set. */
  readonly numbering: Numbering | null;
  /**
   * `invoice:manage_series` held — now, or after the step-up (it is ✦: the
   * surface is OFFERED to a holder and the action steps up, `hasAccess`'s
   * "not for ✦ codes" note).
   */
  readonly canManageNumbering: boolean;
};

/** Where a bank column's ciphertext is bound: the tenant ROW (an issued invoice's copy decrypts under the same). */
export const bankEncryptionContext = (tenantId: string, field: BankField) =>
  ({ tenantId, model: "tenant", rowId: tenantId, field }) as const;

/** A ciphertext that is not one (wrong shape, wrong AAD, tampered) — not a missing key, which is an outage. */
export const isUnreadableCiphertext = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : "";
  return (
    (typeof code === "string" && code.startsWith("ERR_CRYPTO")) ||
    message.includes("unknown format") ||
    message.includes("unable to authenticate")
  );
};

/** Decrypt one bank column; a value that is not a v2 ciphertext under its own AAD reads as unset. */
async function readBankField(
  tx: TenantDb,
  tenantId: string,
  field: BankField,
  stored: string | null,
): Promise<{ value: string | null; unreadable: boolean }> {
  if (stored === null || stored === "") return { value: null, unreadable: false };
  try {
    return { value: await decryptFieldV2(tx, bankEncryptionContext(tenantId, field), stored), unreadable: false };
  } catch (e) {
    // Only an unreadable value reads as unset; a missing tenant key is an
    // outage and must say so rather than show "not set" and a caution that
    // the bank details are missing (the security review's nit).
    if (isUnreadableCiphertext(e)) return { value: null, unreadable: true };
    throw e;
  }
}

/** The company and payment details as stored — decrypted, in sequence (AGENTS.md's `Promise.all` trap). */
export async function readSeller(
  tx: TenantDb,
  tenantId: string,
): Promise<{ company: CompanyDetails; payment: PaymentDetails; unreadable: readonly BankField[] }> {
  const row = await tx.tenant.findFirst({
    where: { id: tenantId },
    select: {
      legalName: true,
      orgNr: true,
      vatNumber: true,
      seat: true,
      fSkattApproved: true,
      addressLine1: true,
      addressLine2: true,
      postalCode: true,
      city: true,
      countryCode: true,
      bankgiro: true,
      plusgiro: true,
      iban: true,
      bic: true,
      invoiceFooterNote: true,
    },
  });
  if (!row) return fail("INVALID_INPUT", "tenant");
  const bank: Record<BankField, string | null> = { bankgiro: null, plusgiro: null, iban: null, bic: null };
  // Stored but not readable (slice 108, the migration review's low): the
  // issue guard copies whatever is stored into the invoice, and its PDF reads
  // strictly — so an unreadable one must stop the issue here, never later.
  const unreadable: BankField[] = [];
  for (const field of BANK_FIELDS) {
    const read = await readBankField(tx, tenantId, field, row[field]);
    bank[field] = read.value;
    if (read.unreadable) unreadable.push(field);
  }
  return {
    unreadable,
    company: {
      legalName: row.legalName,
      orgNr: row.orgNr,
      vatNumber: row.vatNumber,
      seat: row.seat,
      fSkattApproved: row.fSkattApproved,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      postalCode: row.postalCode,
      city: row.city,
      countryCode: row.countryCode,
    },
    payment: { ...bank, footerNote: row.invoiceFooterNote },
  };
}

/** The default payment terms, read inside an existing transaction (no gate: drafts read them too). */
export async function readDefaultPaymentTerms(tx: TenantDb, tenantId: string): Promise<number> {
  const row = await tx.tenantPreference.findFirst({
    where: { tenantId, key: PAYMENT_TERMS_PREF_KEY },
    select: { value: true },
  });
  try {
    const parsed = typeof row?.value === "number" ? normalizePaymentTerms(row.value) : null;
    return parsed ?? PAYMENT_TERMS_DEFAULT;
  } catch {
    // A stored value outside the bounds falls back to the default, as every preference does.
    return PAYMENT_TERMS_DEFAULT;
  }
}

/** Who wrote the newest row of one audit action, and when. */
async function lastChange(tx: TenantDb, tenantId: string, action: string): Promise<Changed> {
  const rows = await tx.$queryRaw<{ actor_id: string | null; at: Date }[]>`
    SELECT a.actor_id, a.created_at AS at
    FROM audit_event a
    WHERE a.tenant_id = ${tenantId} AND a.action = ${action}
    ORDER BY a.created_at DESC
    LIMIT 1`;
  const last = rows[0];
  if (!last) return null;
  const by = last.actor_id
    ? await tx.member.findFirst({ where: { id: last.actor_id }, select: { user: { select: { name: true } } } })
    : null;
  return { by: by?.user.name ?? null, at: last.at };
}

/** `settings:view` with the invoicing module open — the whole page. */
export async function readInvoiceSettings(ctx: InvoicingCtx): Promise<InvoiceSettings> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:view");
    // The page belongs to the invoicing module: closed with it (the design
    // review's nit). `invoice:view` is that module's code, held by everyone
    // who holds `settings:view` in the seeded roles.
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
    const { company, payment, unreadable } = await readSeller(tx, ctx.tenantId);
    const paymentTermsDays = await readDefaultPaymentTerms(tx, ctx.tenantId);
    // In sequence (AGENTS.md's `Promise.all` trap).
    const companyChanged = await lastChange(tx, ctx.tenantId, "invoice_settings.company_changed");
    const paymentChanged = await lastChange(tx, ctx.tenantId, "invoice_settings.payment_details_changed");
    // All four gates, as every verb behind the controls checks (the code
    // review's low: the permission alone lit controls an impersonating
    // admin's every save would refuse).
    const canEdit = await hasAccess(tx, ctx.tenantId, ctx.actor, "settings:edit");
    const numbering = await readNumbering(tx, ctx.tenantId);
    const series = await resolvePermissions(tx, ctx.actor, ["invoice:manage_series"]);
    return {
      company,
      payment,
      paymentTermsDays,
      missing: missingForIssue(company, payment, numbering !== null, unreadable.length > 0),
      companyChanged,
      paymentChanged,
      canEdit,
      numbering,
      canManageNumbering: series.allowed.has("invoice:manage_series") || series.afterStepUp.has("invoice:manage_series"),
    };
  });
}

/** A patch of the company card: only the fields present are written. */
export type CompanyPatch = Partial<Record<Exclude<CompanyField, "fSkattApproved">, unknown>> & {
  readonly fSkattApproved?: boolean;
};

/** Normalise a patch; throws a typed refusal naming the first bad field. */
export function normalizeCompanyPatch(patch: CompanyPatch): Partial<CompanyDetails> {
  const out: Record<string, string | boolean | null> = {};
  if ("legalName" in patch) out.legalName = textOrNull(patch.legalName, SELLER_TEXT_MAX.legalName);
  if ("orgNr" in patch) out.orgNr = normalizeOrgNr(patch.orgNr);
  if ("vatNumber" in patch) out.vatNumber = normalizeSeVatNumber(patch.vatNumber);
  if ("seat" in patch) out.seat = textOrNull(patch.seat, SELLER_TEXT_MAX.seat);
  if ("addressLine1" in patch) out.addressLine1 = textOrNull(patch.addressLine1, SELLER_TEXT_MAX.addressLine);
  if ("addressLine2" in patch) out.addressLine2 = textOrNull(patch.addressLine2, SELLER_TEXT_MAX.addressLine);
  if ("postalCode" in patch) out.postalCode = textOrNull(patch.postalCode, SELLER_TEXT_MAX.postalCode);
  if ("city" in patch) out.city = textOrNull(patch.city, SELLER_TEXT_MAX.city);
  if ("countryCode" in patch) out.countryCode = normalizeCountryCode(patch.countryCode);
  if (patch.fSkattApproved !== undefined) out.fSkattApproved = patch.fSkattApproved;
  return out as Partial<CompanyDetails>;
}

/** The gates every protected write takes, the tenant row locked last. */
async function openProtectedWrite(tx: TenantDb, ctx: InvoicingCtx): Promise<void> {
  await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:edit");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
  await requireRecentMfa(ctx.actor, INVOICE_DETAILS_STEP_UP_MINUTES);
  // The row locked: two changes at once must not interleave their read of
  // "what changed" with each other's write.
  await tx.$queryRaw`SELECT id FROM tenant WHERE id = ${ctx.tenantId} FOR NO KEY UPDATE`;
}

/**
 * `settings:edit` + the code typed in the form (C75 (j)) — write the company
 * card and mail every active owner. Returns the fields that changed.
 */
export async function updateCompanyDetails(
  ctx: InvoicingCtx,
  patch: CompanyPatch,
  now: Date = new Date(),
): Promise<CompanyField[]> {
  const next = normalizeCompanyPatch(patch);
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await openProtectedWrite(tx, ctx);
    const { company } = await readSeller(tx, ctx.tenantId);
    const changed = COMPANY_FIELDS.filter((f) => f in next && next[f] !== company[f]);
    if (changed.length === 0) return [];
    const data = Object.fromEntries(changed.map((f) => [f, next[f]]));
    await tx.tenant.update({ where: { id: ctx.tenantId }, data, select: { id: true } });
    await record(tx, {
      action: "invoice_settings.company_changed",
      targetType: "Tenant",
      targetId: ctx.tenantId,
      metadata: { fields: changed },
    });
    await noticeToOwners(tx, ctx.tenantId, now);
    return changed;
  });
}

export type PaymentPatch = Partial<Record<PaymentField, unknown>>;

/** Normalise a payment patch; throws a typed refusal naming the first bad field. */
export function normalizePaymentPatch(patch: PaymentPatch): Partial<Record<PaymentField, string | null>> {
  const out: Partial<Record<PaymentField, string | null>> = {};
  if ("bankgiro" in patch) out.bankgiro = normalizeBankgiro(patch.bankgiro);
  if ("plusgiro" in patch) out.plusgiro = normalizePlusgiro(patch.plusgiro);
  if ("iban" in patch) out.iban = normalizeIban(patch.iban);
  if ("bic" in patch) out.bic = normalizeBic(patch.bic);
  if ("footerNote" in patch) out.footerNote = textOrNull(patch.footerNote, FOOTER_NOTE_MAX);
  return out;
}

/** The last four characters of a value, for the audit trail; never the whole. */
const lastFour = (value: string | null): string | null => {
  if (value === null) return null;
  const compact = value.replace(/[\s-]/g, "");
  return compact.length <= 4 ? null : compact.slice(-4);
};

/**
 * `settings:edit` + the code typed in the form (C75 (h), (i)) — write the
 * payment details, each changed bank column encrypted again under the
 * tenant's ACTIVE key, and mail every active owner in the same transaction.
 * Returns the fields that changed.
 */
export async function updatePaymentDetails(
  ctx: InvoicingCtx,
  patch: PaymentPatch,
  now: Date = new Date(),
): Promise<PaymentField[]> {
  const next = normalizePaymentPatch(patch);
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await openProtectedWrite(tx, ctx);
    const { payment } = await readSeller(tx, ctx.tenantId);
    const changed = PAYMENT_FIELDS.filter((f) => f in next && next[f] !== payment[f]);
    if (changed.length === 0) return [];
    const data: { bankgiro?: string | null; plusgiro?: string | null; iban?: string | null; bic?: string | null; invoiceFooterNote?: string | null } = {};
    const ends: Partial<Record<BankField, string | null>> = {};
    for (const field of changed) {
      const value = next[field] ?? null;
      if (field === "footerNote") {
        data.invoiceFooterNote = value;
        continue;
      }
      data[field] = value === null ? null : await encryptFieldV2(tx, bankEncryptionContext(ctx.tenantId, field), value);
      ends[field] = lastFour(value);
    }
    await tx.tenant.update({ where: { id: ctx.tenantId }, data, select: { id: true } });
    await record(tx, {
      action: "invoice_settings.payment_details_changed",
      targetType: "Tenant",
      targetId: ctx.tenantId,
      metadata: {
        fields: changed,
        lastFour: ends,
        ...(changed.includes("footerNote") ? { footerNote: data.invoiceFooterNote ?? null } : {}),
      },
    });
    await noticeToOwners(tx, ctx.tenantId, now);
    return changed;
  });
}

/**
 * C75 (h)–(j): every ACTIVE owner is mailed that what the invoices say changed
 * — the reply address's notice (`src/notify/reply-address.ts`), whatever their
 * email level, never to a suppressed address (the reply address's precedent:
 * the change still goes; recorded as the security review's nit). The mail
 * names nothing and carries no `Reply-To` (`MAIL_WITHOUT_REPLY_TO`): a
 * security notice to the workspace's own people.
 */
async function noticeToOwners(tx: TenantDb, tenantId: string, now: Date): Promise<void> {
  const owners = await tx.member.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      memberRoles: { some: { role: { isSystem: true, templateKey: "owner" } } },
    },
    select: { id: true, user: { select: { email: true, locale: true } } },
    orderBy: { id: "asc" },
  });
  const receivers = owners.flatMap((o) =>
    o.user.email ? [{ id: o.id, email: o.user.email.toLowerCase(), locale: o.user.locale === "sv" ? "sv" : "en" }] : [],
  );
  if (receivers.length === 0) return;
  const suppressed = new Set(
    (
      await tx.emailSuppression.findMany({
        where: { email: { in: receivers.map((r) => r.email) } },
        select: { email: true },
      })
    ).map((s) => s.email),
  );
  const data = receivers
    .filter((r) => !suppressed.has(r.email))
    .map((r) => ({
      tenantId,
      idempotencyKey: `invoice_details_changed:${now.toISOString()}:MEMBER:${r.id}`,
      receiverType: "MEMBER" as const,
      receiverId: r.id,
      toEmail: r.email,
      kind: INVOICE_DETAILS_CHANGED_MAIL,
      locale: r.locale,
      notificationIds: [],
    }));
  if (data.length > 0) await tx.emailOutbox.createMany({ data, skipDuplicates: true });
}

/** `settings:edit` — the default payment terms. Returns whether it changed. */
export async function updateDefaultPaymentTerms(ctx: InvoicingCtx, raw: unknown): Promise<boolean> {
  const terms = normalizePaymentTerms(raw);
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:edit");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
    const key = PAYMENT_TERMS_PREF_KEY;
    const existing = await tx.tenantPreference.findFirst({ where: { tenantId: ctx.tenantId, key }, select: { id: true, value: true } });
    if (terms === null) {
      // Blank is "the default": the row goes rather than storing a null.
      if (!existing) return false;
      await tx.tenantPreference.deleteMany({ where: { tenantId: ctx.tenantId, key } });
    } else {
      if (existing?.value === terms) return false;
      // An upsert, so two first saves at once cannot both INSERT and turn the
      // unique (tenant, key) into an error page (the security review's nit).
      await tx.tenantPreference.upsert({
        where: { tenantId_key: { tenantId: ctx.tenantId, key } },
        create: { tenantId: ctx.tenantId, key, value: terms, updatedByMemberId: ctx.actor.memberId },
        update: { value: terms, updatedByMemberId: ctx.actor.memberId },
      });
    }
    await record(tx, { action: "preference.changed", targetType: "TenantPreference", targetId: key, metadata: { key } });
    return true;
  });
}
