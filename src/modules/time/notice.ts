import { record } from "@/audit/record";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { isUniqueViolation } from "@/lib/domain-error";

import { ensureTimeDefaults } from "./bootstrap";
import { principalOf, type TimeCtx } from "./ctx";

/**
 * The staff notice (SECURITY.md §9.7.5; DATA_MODEL.md §6.15): what the
 * tenant tells its staff before time tracking starts. Versioned rows,
 * one per locale; the CURRENT version is the highest published one.
 * Timers AND clock-in refuse to start until the member has acknowledged
 * the current version (notice, not consent — §9.7.1). sv/en draft text
 * is seeded lazily per tenant (version 1, published by the system) so
 * 2T is demoable; the tenant edits and republishes (= a new version,
 * re-acknowledgment required). Lawyer sign-off on the text is a
 * go-live gate for Naxdor (PLAN.md 2T founder inputs), not a code gate.
 */

export const STAFF_NOTICE_PURPOSES = ["billing", "planning", "profitability", "working_time"] as const;

export type StaffNoticeText = { readonly title: string; readonly body: string };

/** Draft text, both locales. Markdown; the tenant may edit it. */
export const STAFF_NOTICE_SEED: Readonly<Record<"en" | "sv", StaffNoticeText>> = {
  en: {
    title: "How Fortleva records your working time",
    body: `## What is recorded

Only time you report yourself: a timer you start and stop, or an entry you type — with the task, project, agreement, work type, an optional note and whether it is billable. If your workplace uses shifts, also the clock-in, clock-out and breaks you record. A recorded break is an unpaid **rast**; a short **paus** is working time and is simply not clocked. Timestamps are set by the server when you press the button. You can edit your own entries and shifts; every edit is logged.

## What is never recorded

No idle detection, screenshots or screen recording; no application, website or keystroke capture; no presence or "who is working now" indicator (not even while on shift); no per-minute activity maps, leaderboards or rankings; no geolocation or location from your network address; no timelines visible to colleagues; no reading of your calendar or mail; no productivity score. The software cannot do these things — they are not switched off, they do not exist.

## Why

Client billing, capacity planning, project profitability and working-time records (arbetstidsregistrering). Explicitly **not** performance evaluation. Legal basis: the employment contract (GDPR Art. 6(1)(b)) and the employer's legitimate interest (Art. 6(1)(f)). This is information, not a request for consent — consent is not a valid basis at work.

## Who sees what

- **You** see and can export all of your own entries and shifts at any time.
- **Managers** with the team permission see hours per person per project and day totals of closed shifts — never a live clock — and, with their own permissions, billing rates and budgets.
- **Finance / management** may see internal cost rates and margins, behind two-factor authentication.
- **Clients** never see an entry, a name, a per-person figure or a rate — only project-level monthly totals when the project shares hours, and reports that were explicitly published.

## How long

Entries on an issued invoice are kept 7 years (bookkeeping law). Other entries and shifts are working-time records: 2 years (Sweden) or 3 years (US work country) by default, unless your employer sets another period. Log rows about your data are kept 24 months.

## Your rights

See, export and ask for correction of your data at any time (Art. 15–20). On erasure, un-invoiced entries are pseudonymised; invoiced ones are kept as bookkeeping records. Your employer is the controller; Fortleva is the processor acting on its instructions.`,
  },
  sv: {
    title: "Så registrerar Fortleva din arbetstid",
    body: `## Vad som registreras

Bara tid du själv rapporterar: en timer du startar och stoppar, eller en post du skriver in — med uppgift, projekt, avtal, arbetstyp, en valfri anteckning och om tiden är fakturerbar. Om din arbetsplats använder arbetspass även in- och utstämpling och de raster du registrerar. En registrerad rast är obetald **rast**; en kort **paus** är arbetstid och stämplas helt enkelt inte. Tidsstämplar sätts av servern när du trycker på knappen. Du kan redigera dina egna poster och pass; varje ändring loggas.

## Vad som aldrig registreras

Ingen inaktivitetsmätning, inga skärmdumpar eller skärminspelningar; ingen registrering av program, webbplatser eller tangenttryckningar; ingen närvaro- eller "vem jobbar nu"-indikator (inte ens under ett pass); inga aktivitetskartor per minut, topplistor eller rankningar; ingen platsinformation från GPS eller nätverksadress; inga tidslinjer som kollegor kan se; ingen läsning av din kalender eller e-post; inget produktivitetspoäng. Programvaran kan inte göra detta — funktionerna är inte avstängda, de finns inte.

## Varför

Kundfakturering, kapacitetsplanering, projektlönsamhet och arbetstidsregistrering. Uttryckligen **inte** prestationsbedömning. Rättslig grund: anställningsavtalet (GDPR art. 6.1 b) och arbetsgivarens berättigade intresse (art. 6.1 f). Detta är information, inte en begäran om samtycke — samtycke är inte en giltig grund i anställningsförhållandet.

## Vem ser vad

- **Du** ser och kan exportera alla dina egna poster och pass när som helst.
- **Chefer** med teambehörighet ser timmar per person och projekt samt dagssummor för avslutade pass — aldrig en pågående klocka — och, med egen behörighet, timpriser och budgetar.
- **Ekonomi / ledning** kan se interna kostnadssatser och marginaler, bakom tvåfaktorsautentisering.
- **Kunder** ser aldrig en post, ett namn, en siffra per person eller ett pris — bara månadssummor per projekt när projektet delar timmar, och rapporter som uttryckligen publicerats.

## Hur länge

Poster på en utfärdad faktura sparas i 7 år (bokföringslagen). Övriga poster och pass är arbetstidsuppgifter: 2 år (Sverige) eller 3 år (arbetsland USA) som standard, om inte arbetsgivaren anger en annan tid. Loggrader om dina uppgifter sparas i 24 månader.

## Dina rättigheter

Se, exportera och begär rättelse av dina uppgifter när som helst (art. 15–20). Vid radering pseudonymiseras ofakturerade poster; fakturerade behålls som räkenskapsinformation. Din arbetsgivare är personuppgiftsansvarig; Fortleva är personuppgiftsbiträde och följer arbetsgivarens instruktioner.`,
  },
};

const SEED_LOCALES = ["sv", "en"] as const;

/**
 * Lazy, idempotent seed: version 1 in both locales, published by the
 * system. Runs under the system principal (bootstrap.ts) so the audit
 * row names SYSTEM, not whichever member happened to start the first
 * timer. Race-safe on the (tenant, version, locale) unique.
 */
export async function ensureStaffNotice(tx: TenantDb, tenantId: string): Promise<boolean> {
  const existing = await tx.staffNotice.count({ where: { tenantId } });
  if (existing > 0) return false;
  const publishedAt = new Date();
  const { count } = await tx.staffNotice.createMany({
    data: SEED_LOCALES.map((locale) => ({
      tenantId,
      version: 1,
      locale,
      title: STAFF_NOTICE_SEED[locale].title,
      body: STAFF_NOTICE_SEED[locale].body,
      purposes: [...STAFF_NOTICE_PURPOSES],
      jurisdictionTags: ["SE"],
      publishedAt,
    })),
    skipDuplicates: true,
  });
  if (count === 0) return false;
  await record(tx, {
    action: "staff_notice.published",
    targetType: "StaffNotice",
    targetId: `${tenantId}:1`,
    metadata: { version: 1, seeded: true, locales: [...SEED_LOCALES] },
  });
  return true;
}

export type NoticeView = {
  id: string;
  version: number;
  locale: string;
  title: string;
  body: string;
  purposes: string[];
  jurisdictionTags: string[];
  publishedAt: Date | null;
};

export type NoticeStatus = {
  /** A published notice exists (after the seed: always). */
  required: boolean;
  /** The member has acknowledged the CURRENT version. */
  acknowledged: boolean;
  /** The current version rendered in the best locale for the member. */
  notice: NoticeView | null;
};

/** Inside an existing tx: the member's standing against the current version. */
export async function noticeStatusFor(
  tx: TenantDb,
  tenantId: string,
  memberId: string,
  preferredLocale?: string,
): Promise<NoticeStatus> {
  const latest = await tx.staffNotice.findFirst({
    where: { tenantId, publishedAt: { not: null } },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  if (!latest) return { required: false, acknowledged: true, notice: null };
  const [rows, tenant, ack] = await Promise.all([
    tx.staffNotice.findMany({
      where: { tenantId, version: latest.version, publishedAt: { not: null } },
      orderBy: { locale: "asc" },
    }),
    tx.tenant.findFirst({ where: { id: tenantId }, select: { defaultLocale: true } }),
    tx.staffNoticeAcknowledgment.findFirst({
      where: { tenantId, memberId, noticeVersion: latest.version },
      select: { id: true },
    }),
  ]);
  const pick =
    rows.find((r) => r.locale === preferredLocale) ??
    rows.find((r) => r.locale === tenant?.defaultLocale) ??
    rows[0];
  return {
    required: true,
    acknowledged: ack !== null,
    notice: pick
      ? {
          id: pick.id,
          version: pick.version,
          locale: pick.locale,
          title: pick.title,
          body: pick.body,
          purposes: pick.purposes,
          jurisdictionTags: pick.jurisdictionTags,
          publishedAt: pick.publishedAt,
        }
      : null,
  };
}

/** The gate: timers and clock-in call this first (DomainError NOTICE_UNACKNOWLEDGED). */
export async function assertNoticeAcknowledged(
  tx: TenantDb,
  tenantId: string,
  memberId: string,
): Promise<void> {
  const status = await noticeStatusFor(tx, tenantId, memberId);
  if (status.required && !status.acknowledged) fail("NOTICE_UNACKNOWLEDGED");
}

/** time:track — what the timer UI shows before the first start. */
export async function getNoticeStatus(ctx: TimeCtx, preferredLocale?: string): Promise<NoticeStatus> {
  await ensureTimeDefaults(ctx.tenantId); // the notice must exist before anyone can read it
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
    return noticeStatusFor(tx, ctx.tenantId, ctx.actor.memberId, preferredLocale);
  });
}

/** time:track — the member acknowledges the rendering they were shown. Idempotent. */
export async function acknowledgeNotice(ctx: TimeCtx, noticeId: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
    const notice = await tx.staffNotice.findFirst({
      where: { tenantId: ctx.tenantId, id: noticeId, publishedAt: { not: null } },
      select: { id: true, version: true, locale: true },
    });
    if (!notice) fail("INVALID_INPUT", "unknown notice");
    try {
      await tx.staffNoticeAcknowledgment.create({
        data: {
          tenantId: ctx.tenantId,
          memberId: ctx.actor.memberId,
          noticeId: notice!.id,
          noticeVersion: notice!.version,
          locale: notice!.locale,
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) return; // already acknowledged — nothing to audit twice
      throw e;
    }
    await record(tx, {
      action: "staff_notice.acknowledged",
      targetType: "StaffNotice",
      targetId: notice!.id,
      metadata: { version: notice!.version, locale: notice!.locale },
    });
  });
}

/**
 * settings:edit — publish a new version (all locales at once). Every
 * member must re-acknowledge: the gate checks the highest version.
 */
export async function publishNotice(
  ctx: TimeCtx,
  input: {
    texts: readonly { locale: string; title: string; body: string }[];
    purposes?: readonly string[];
    jurisdictionTags?: readonly string[];
  },
): Promise<{ version: number }> {
  if (input.texts.length === 0) fail("INVALID_INPUT", "at least one locale");
  for (const t of input.texts) {
    if (t.title.trim() === "" || t.body.trim() === "") fail("INVALID_INPUT", "title and body required");
  }
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:edit");
    const latest = await tx.staffNotice.findFirst({
      where: { tenantId: ctx.tenantId },
      orderBy: { version: "desc" },
      select: { version: true, purposes: true, jurisdictionTags: true },
    });
    const version = (latest?.version ?? 0) + 1;
    const publishedAt = new Date();
    await tx.staffNotice.createMany({
      data: input.texts.map((t) => ({
        tenantId: ctx.tenantId,
        version,
        locale: t.locale,
        title: t.title.trim(),
        body: t.body,
        purposes: [...(input.purposes ?? latest?.purposes ?? STAFF_NOTICE_PURPOSES)],
        jurisdictionTags: [...(input.jurisdictionTags ?? latest?.jurisdictionTags ?? ["SE"])],
        publishedAt,
        publishedByMemberId: ctx.actor.memberId,
      })),
    });
    await record(tx, {
      action: "staff_notice.published",
      targetType: "StaffNotice",
      targetId: `${ctx.tenantId}:${version}`,
      metadata: { version, locales: input.texts.map((t) => t.locale) },
    });
    return { version };
  });
}

/** settings:view — who has acknowledged the current version (for /settings/time). */
export async function listNoticeAcknowledgments(
  ctx: TimeCtx,
): Promise<{ version: number | null; members: { memberId: string; name: string; acknowledgedAt: Date | null }[] }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:view");
    const latest = await tx.staffNotice.findFirst({
      where: { tenantId: ctx.tenantId, publishedAt: { not: null } },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const members = await tx.member.findMany({
      where: { tenantId: ctx.tenantId, status: "ACTIVE" },
      select: { id: true, user: { select: { name: true } } },
      orderBy: { joinedAt: "asc" },
    });
    if (!latest) {
      return { version: null, members: members.map((m) => ({ memberId: m.id, name: m.user.name, acknowledgedAt: null })) };
    }
    const acks = await tx.staffNoticeAcknowledgment.findMany({
      where: { tenantId: ctx.tenantId, noticeVersion: latest.version },
      select: { memberId: true, acknowledgedAt: true },
    });
    const byMember = new Map(acks.map((a) => [a.memberId, a.acknowledgedAt]));
    return {
      version: latest.version,
      members: members.map((m) => ({
        memberId: m.id,
        name: m.user.name,
        acknowledgedAt: byMember.get(m.id) ?? null,
      })),
    };
  });
}
