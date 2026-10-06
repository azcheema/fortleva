import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { resetTenantDekCache } from "@/crypto/tenant-key";
import { DomainError } from "@/lib/domain-error";
import { suspendMember } from "@/members/admin";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { updatePreferences } from "@/preferences/service";

import { REVEAL_ACTIONS } from "./budget";
import type { ExportLabels } from "./export-csv";
import {
  createCredential,
  deleteCredential,
  exportCredentials,
  listVaultExports,
  replaceCredentialSecret,
  revealCredentialField,
  type ExportScope,
} from "./index";

/**
 * THE EXPORT (Phase 3V slice 95; founder decision C63) against the real
 * database and the real app_runtime role: who may export (the owner
 * template only, with a factor this minute), what one file carries (every
 * live login the member reaches — archived and sealed in, the bin out, our
 * own for a tenant-wide scope only), one audit row per login, the notice to
 * every holder, the history, the offboarding flags it feeds, and the race
 * with the exporter's removal.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let acmeTwin: string;
let beta: string;
let empty: string;
let acmeP: string;
const extraUsers: string[] = [];
let secondOwner: string;
let secondOwnerEmail: string;
let scopedHolder: string;
let racer: string;

const RUN = randomUUID().slice(0, 8);
const TOTP_SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const CANARY = `canary-${RUN}-pw`;

const ctxOf = (actor: MemberActor) => ({ tenantId: f.tenantId, actor });
const owner = () => ctxOf(actorFor(f.seats.owner.memberId));
const admin = () => ctxOf(actorFor(f.seats.admin.memberId));
const manager = () => ctxOf(actorFor(f.seats.manager.memberId));
const employee = () => ctxOf(actorFor(f.seats.employee.memberId));
const ALL: ExportScope = { kind: "all" };

const LABELS: ExportLabels = {
  product: "Fortleva",
  types: {
    LOGIN: "Login",
    SECURE_NOTE: "Secure note",
    API_KEY: "API key",
    SSH_KEY: "SSH key",
    DATABASE: "Database",
    SERVER: "Server",
    WIFI: "Wi-Fi",
    SOFTWARE_LICENSE: "Software licence",
    OTHER: "Other",
  },
  fields: { password: "Password", note: "Note", apiKey: "API key", apiSecret: "API secret" },
  project: "Project",
  username: "Username",
  url: "Web address",
  totp: "Authenticator",
  tags: "Tags",
  expires: "Expires",
  rotateEvery: (days) => `Change every ${days} days`,
  lastChanged: "Last changed",
  changeSoon: "Change soon",
  shownToClient: "Shown to the client",
  sealed: "Sealed for the client",
  archived: "Archived",
};

/** "ok", or the reason — with the detail for FORBIDDEN, which has several. */
const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason === "FORBIDDEN" ? `FORBIDDEN:${e.detail ?? ""}` : e.reason;
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

/** A tiny RFC 4180 reader: the file's records as objects keyed by its header. */
function parse(csv: string): Record<string, string>[] {
  const records: string[][] = [];
  let cell = "";
  let rec: string[] = [];
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      rec.push(cell);
      cell = "";
    } else if (ch === "\r" && csv[i + 1] === "\n") {
      rec.push(cell);
      records.push(rec);
      rec = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  const [header, ...rows] = records;
  return rows.map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i] ?? ""])));
}

const exportedRows = async () => f.audits("credential.exported");
const outboxOf = async () =>
  f.platform.emailOutbox.findMany({ where: { tenantId: f.tenantId, kind: "vault.exported" }, orderBy: { createdAt: "asc" } });

/** A member on a custom role holding exactly `codes`, optionally assigned to one client directly. */
async function memberWith(label: string, codes: readonly string[], clientId?: string): Promise<string> {
  const userId = randomUUID();
  extraUsers.push(userId);
  await f.platform.user.create({ data: { id: userId, name: `${label} ${RUN}`, email: `${label}-${RUN}@test.invalid` } });
  const member = await f.platform.member.create({ data: { tenantId: f.tenantId, userId } });
  const perms = await f.platform.permission.findMany({ where: { code: { in: [...codes] } }, select: { id: true } });
  expect(perms).toHaveLength(codes.length);
  const role = await f.platform.role.create({ data: { tenantId: f.tenantId, name: `${label}-${RUN}` } });
  await f.platform.rolePermission.createMany({
    data: perms.map((p) => ({ tenantId: f.tenantId, roleId: role.id, permissionId: p.id })),
  });
  await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: member.id, roleId: role.id } });
  if (clientId) await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: member.id, clientId } });
  return member.id;
}

const L: Record<string, string> = {};

beforeAll(async () => {
  f = await setupTenant("vexp");
  acme = randomUUID();
  acmeTwin = randomUUID();
  beta = randomUUID();
  empty = randomUUID();
  acmeP = randomUUID();
  await f.platform.client.create({ data: { id: acme, tenantId: f.tenantId, name: "Acme" } });
  // A second client of the same name: its logins must land in a folder of their own.
  await f.platform.client.create({ data: { id: acmeTwin, tenantId: f.tenantId, name: "Acme" } });
  await f.platform.client.create({ data: { id: beta, tenantId: f.tenantId, name: "Beta" } });
  await f.platform.client.create({ data: { id: empty, tenantId: f.tenantId, name: "Empty" } });
  await f.platform.project.create({ data: { id: acmeP, tenantId: f.tenantId, clientId: acme, key: "EXP", name: "Acme site" } });

  const make = async (key: string, input: Parameters<typeof createCredential>[1]) => {
    L[key] = (await createCredential(owner(), input)).id;
  };
  await make("registrar", { clientId: null, type: "LOGIN", name: "Registrar", username: "us", secret: { password: "reg-pw" }, totp: TOTP_SEED });
  await make("hosting", {
    clientId: acme,
    type: "LOGIN",
    name: "Hosting",
    username: "admin@acme.se",
    url: "https://panel.example.com",
    notes: "Billing is Eva",
    secret: { password: CANARY },
  });
  await make("api", { clientId: acme, type: "API_KEY", name: "Mail API", secret: { apiKey: "key-1", apiSecret: "sec-1" } });
  await make("note", { clientId: acme, type: "SECURE_NOTE", name: "Alarm", secret: { note: "1234#" } });
  await make("archived", { clientId: acme, type: "LOGIN", name: "Old CMS", secret: { password: "old-pw" } });
  await make("sealed", { clientId: acme, type: "LOGIN", name: "Bank", secret: { password: "bank-pw" } });
  await make("binned", { clientId: acme, type: "LOGIN", name: "Binned", secret: { password: "binned-pw" } });
  await make("project", { clientId: acme, projectId: acmeP, type: "LOGIN", name: "Staging", secret: { password: "stage-pw" } });
  await make("twin", { clientId: acmeTwin, type: "LOGIN", name: "Twin login", secret: { password: "twin-pw" } });
  await make("beta", { clientId: beta, type: "LOGIN", name: "Beta login", secret: { password: "beta-pw" } });
  await f.platform.credentialItem.update({ where: { id: L.archived! }, data: { archivedAt: new Date() } });
  await f.platform.credentialItem.update({ where: { id: L.sealed! }, data: { sealedAt: new Date() } });
  await deleteCredential(owner(), L.binned!);

  // A second OWNER — who gets the notice too — and two custom-role holders.
  secondOwnerEmail = `owner2-${RUN}@test.invalid`;
  const userId = randomUUID();
  extraUsers.push(userId);
  await f.platform.user.create({ data: { id: userId, name: `Second owner ${RUN}`, email: secondOwnerEmail } });
  secondOwner = (await f.platform.member.create({ data: { tenantId: f.tenantId, userId } })).id;
  await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: secondOwner, roleId: f.roleId("owner") } });
  scopedHolder = await memberWith("scoped", ["credential:view", "credential:reveal", "credential:export"], beta);
  racer = await memberWith("racer", ["credential:view", "credential:reveal", "credential:export", "client:view_all"]);
}, 180_000);

afterAll(async () => {
  if (f) {
    await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.emailSuppression.deleteMany({ where: { email: secondOwnerEmail } });
    await f.platform.credentialItem.updateMany({ where: { tenantId: f.tenantId }, data: { sealedAt: null } });
    await f.platform.credentialItem.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
    // The extra members go before their users (the fixture's cleanup then
    // removes roles and grants by tenant, and only its own users).
    await f.platform.memberRole.deleteMany({ where: { tenantId: f.tenantId, member: { userId: { in: extraUsers } } } });
    await f.platform.member.deleteMany({ where: { tenantId: f.tenantId, userId: { in: extraUsers } } });
    await f.platform.user.deleteMany({ where: { id: { in: extraUsers } } });
  }
  resetTenantDekCache();
  await f?.cleanup();
}, 180_000);

describe("what an owner's export carries", () => {
  let file: Awaited<ReturnType<typeof exportCredentials>>;
  let rows: Record<string, string>[];
  const log = vi.fn();

  beforeAll(async () => {
    // The log-scrub half for this path: nothing the export does reaches the console.
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(log));
    try {
      file = await exportCredentials(owner(), ALL, LABELS);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    rows = parse(file.csv);
  }, 60_000);

  it("every live login the owner reaches — archived and sealed in, the bin out — our own first", () => {
    expect(rows.map((r) => r.name).sort()).toEqual(
      ["Registrar", "Hosting", "Mail API", "Alarm", "Old CMS", "Bank", "Staging", "Twin login", "Beta login"].sort(),
    );
    expect(file.count).toBe(9);
    expect(rows[0]!.name).toBe("Registrar");
    expect(rows.some((r) => r.name === "Binned")).toBe(false);
    expect(file.csv).not.toContain("binned-pw");
  });

  it("writes every secret as stored — the main one as the password, the others in the notes, the seed as an otpauth URI", () => {
    const by = (name: string) => rows.find((r) => r.name === name)!;
    expect(by("Hosting")).toMatchObject({
      type: "login",
      login_username: "admin@acme.se",
      login_uri: "https://panel.example.com",
      login_password: CANARY,
    });
    expect(by("Hosting").notes).toContain("Billing is Eva");
    expect(by("Mail API").login_password).toBe("key-1");
    expect(by("Mail API").notes).toContain("API secret:\nsec-1");
    expect(by("Alarm").type).toBe("note");
    expect(by("Alarm").notes).toContain("1234#");
    expect(by("Registrar").login_totp).toBe(
      `otpauth://totp/Registrar?secret=${TOTP_SEED}&algorithm=SHA1&digits=6&period=30`,
    );
    expect(by("Staging").notes).toContain("Project: Acme site");
    expect(by("Old CMS").notes).toContain("Archived");
    expect(by("Bank").reprompt).toBe("1");
  });

  it("folds each client into a folder of its own — the workspace for our own, a twin name told apart", async () => {
    const tenant = await f.platform.tenant.findUniqueOrThrow({ where: { id: f.tenantId }, select: { name: true } });
    const folderOf = (name: string) => rows.find((r) => r.name === name)!.folder;
    expect(folderOf("Registrar")).toBe(tenant.name);
    expect(folderOf("Beta login")).toBe("Beta");
    expect(new Set([folderOf("Hosting"), folderOf("Twin login")])).toEqual(new Set(["Acme", "Acme (2)"]));
    expect(folderOf("Hosting")).toBe(folderOf("Staging"));
  });

  it("records one credential.exported per login, one export id, the owner as actor — never a value", async () => {
    const audits = await exportedRows();
    expect(audits).toHaveLength(9);
    expect(new Set(audits.map((a) => a.targetId))).toEqual(new Set(Object.entries(L).filter(([k]) => k !== "binned").map(([, id]) => id)));
    const ids = new Set(audits.map((a) => (a.metadata as { exportId: string }).exportId));
    expect(ids.size).toBe(1);
    for (const a of audits) {
      expect(a.actorType).toBe("MEMBER");
      expect(a.actorId).toBe(f.seats.owner.memberId);
      // `seed` marks the one login whose authenticator seed left in the file (C63 (e)).
      expect(a.metadata).toEqual({ exportId: [...ids][0], scope: "all", ...(a.targetId === L.registrar ? { seed: true } : {}) });
    }
    expect(JSON.stringify(audits)).not.toContain(CANARY);
  });

  it("mails every holder of the code — the exporter included — and nobody else", async () => {
    const mail = await outboxOf();
    expect(mail.map((m) => m.receiverId).sort()).toEqual([f.seats.owner.memberId, secondOwner, racer, scopedHolder].sort());
    for (const m of mail) {
      expect(m.receiverType).toBe("MEMBER");
      // A link, never data (ARC-09): the mail carries no parameters at all.
      expect(m.params).toBeNull();
      expect(m.kind).toBe("vault.exported");
    }
  });

  it("does not spend the reveal budget, and logs nothing", async () => {
    expect((REVEAL_ACTIONS as readonly string[]).includes("credential.exported")).toBe(false);
    // With a budget of ONE an hour, the nine rows the export just wrote would
    // refuse this reveal if they counted (the code review: at thirty, a reveal
    // after a nine-login export proved nothing).
    await updatePreferences(owner(), { vault: { revealBudgetPerHour: 1 } });
    try {
      await expect(revealCredentialField(owner(), L.hosting!, "password")).resolves.toBe(CANARY);
    } finally {
      await updatePreferences(owner(), { vault: { revealBudgetPerHour: 30 } });
    }
    expect(log).not.toHaveBeenCalled();
  });
});

describe("what the member asked for, as far as they reach", () => {
  it("one client: its logins, its projects' included, and nothing else", async () => {
    const before = (await exportedRows()).length;
    const file = await exportCredentials(owner(), { kind: "client", clientId: acme }, LABELS);
    expect(parse(file.csv).map((r) => r.name).sort()).toEqual(["Alarm", "Bank", "Hosting", "Mail API", "Old CMS", "Staging"]);
    const rows = (await exportedRows()).slice(before);
    expect(rows).toHaveLength(6);
    expect(rows[0]!.metadata).toMatchObject({ scope: "client", clientId: acme });
  });

  it("our own: the agency's logins alone", async () => {
    const file = await exportCredentials(owner(), { kind: "agency" }, LABELS);
    expect(parse(file.csv).map((r) => r.name)).toEqual(["Registrar"]);
  });

  it("a client with no logins is NOTHING_TO_EXPORT — no audit row, no mail", async () => {
    const audits = (await exportedRows()).length;
    const mails = (await outboxOf()).length;
    expect(await outcome(exportCredentials(owner(), { kind: "client", clientId: empty }, LABELS))).toBe("NOTHING_TO_EXPORT");
    expect(await outcome(exportCredentials(owner(), { kind: "client", clientId: randomUUID() }, LABELS))).toBe("NOTHING_TO_EXPORT");
    expect((await exportedRows()).length).toBe(audits);
    expect((await outboxOf()).length).toBe(mails);
  });

  it("a holder kept to one client exports that client's logins only — never our own, never another's", async () => {
    const scoped = () => ctxOf(actorFor(scopedHolder));
    expect(parse((await exportCredentials(scoped(), ALL, LABELS)).csv).map((r) => r.name)).toEqual(["Beta login"]);
    expect(await outcome(exportCredentials(scoped(), { kind: "agency" }, LABELS))).toBe("NOTHING_TO_EXPORT");
    expect(await outcome(exportCredentials(scoped(), { kind: "client", clientId: acme }, LABELS))).toBe("NOTHING_TO_EXPORT");
  });

  it("refuses a scope that is none of the three shapes before reading anything", async () => {
    expect(await outcome(exportCredentials(owner(), { kind: "everything" } as unknown as ExportScope, LABELS))).toBe("INVALID_INPUT");
  });
});

describe("who may export", () => {
  it("only the owner template holds the code: an admin (who may reveal), a manager and an employee are refused", async () => {
    const audits = (await exportedRows()).length;
    expect(await outcome(exportCredentials(admin(), ALL, LABELS))).toMatch(/^FORBIDDEN/);
    expect(await outcome(exportCredentials(manager(), ALL, LABELS))).toMatch(/^FORBIDDEN/);
    expect(await outcome(exportCredentials(employee(), ALL, LABELS))).toMatch(/^FORBIDDEN/);
    expect((await exportedRows()).length).toBe(audits);
  });

  it("export without reveal is refused — a file of every secret is every reveal at once", async () => {
    const noReveal = await memberWith("noreveal", ["credential:view", "credential:export", "client:view_all"]);
    expect(await outcome(exportCredentials(ctxOf(actorFor(noReveal)), ALL, LABELS))).toMatch(/^FORBIDDEN/);
  });

  it("ALWAYS a fresh factor: one two minutes old opens the vault but not the export", async () => {
    const stale: MemberActor = { memberId: f.seats.owner.memberId, mfa: { enrolled: true, verifiedAt: new Date(Date.now() - 2 * 60_000) } };
    expect(await outcome(exportCredentials(ctxOf(stale), ALL, LABELS))).toBe("MFA_REQUIRED");
  });

  it("impersonation never exports, even with a fresh factor", async () => {
    const imp: MemberActor = { ...actorFor(f.seats.owner.memberId), impersonated: true };
    expect(await outcome(exportCredentials(ctxOf(imp), ALL, LABELS))).toMatch(/^FORBIDDEN/);
  });

  it("a suppressed address gets no notice; the others still do", async () => {
    await f.platform.emailSuppression.create({ data: { email: secondOwnerEmail, reason: "HARD_BOUNCE", source: "manual" } });
    const before = new Set((await outboxOf()).map((m) => m.id));
    await exportCredentials(owner(), { kind: "agency" }, LABELS);
    const fresh = (await outboxOf()).filter((m) => !before.has(m.id));
    expect(fresh.map((m) => m.receiverId)).not.toContain(secondOwner);
    expect(fresh.map((m) => m.receiverId)).toContain(f.seats.owner.memberId);
  });
});

describe("the exports page's read", () => {
  it("lists each export once — who, how many, which, newest first — for a tenant-wide holder", async () => {
    const history = await listVaultExports(owner());
    expect(history?.kind).toBe("list");
    const rows = history?.kind === "list" ? history.rows : [];
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows[0]!.at.getTime()).toBeGreaterThanOrEqual(rows[rows.length - 1]!.at.getTime());
    const all = rows.find((r) => r.scope === "all" && r.count === 9);
    const ownerName = (await f.platform.user.findUniqueOrThrow({ where: { id: f.seats.owner.userId }, select: { name: true } })).name;
    expect(all?.by).toBe(ownerName);
    const one = rows.find((r) => r.scope === "client");
    expect(one?.client).toEqual({ id: acme, name: "Acme" });
    expect(one?.count).toBe(6);
  });

  it("a holder kept to some clients is told it is not theirs to see; a non-holder gets nothing", async () => {
    expect(await listVaultExports(ctxOf(actorFor(scopedHolder)))).toEqual({ kind: "scoped" });
    expect(await listVaultExports(admin())).toBeNull();
  });
});

describe("a seed a leaver exported keeps the mark until it is replaced too (C63 (e))", () => {
  const SEED_TWO = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const SEED_THREE = "MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U";
  const S: Record<string, string> = {};
  let leaver: string;

  const marked = async (id: string) =>
    (await f.platform.credentialItem.findUniqueOrThrow({ where: { id }, select: { needsRotation: true } })).needsRotation;

  beforeAll(async () => {
    for (const k of ["kept", "reseeded", "plain", "twoSaves", "voided"]) {
      S[k] = (
        await createCredential(owner(), {
          clientId: null,
          type: "LOGIN",
          name: `Leaver ${k}`,
          secret: { password: `${k}-pw` },
          ...(k === "plain" ? {} : { totp: TOTP_SEED }),
        })
      ).id;
    }
    leaver = await memberWith("leaver", ["credential:view", "credential:reveal", "credential:export", "client:view_all"]);
    await exportCredentials(ctxOf(actorFor(leaver)), { kind: "agency" }, LABELS);
    // A seed changed AFTER the export: the copy in the leaver's file is dead.
    await replaceCredentialSecret(owner(), S.reseeded!, { totp: SEED_TWO });
    await suspendMember({ tenantId: f.tenantId, actor: owner().actor, memberId: leaver });
  }, 120_000);

  it("the removal marked each exported login, and the export recorded where a seed left", async () => {
    for (const id of Object.values(S)) expect(await marked(id)).toBe(true);
    const rows = (await exportedRows()).filter((a) => a.actorId === leaver);
    expect(rows.find((r) => r.targetId === S.kept)!.metadata).toMatchObject({ seed: true });
    expect(rows.find((r) => r.targetId === S.plain)!.metadata).not.toHaveProperty("seed");
  });

  it("a new password alone keeps the mark on a login whose seed the leaver took; a new seed with it clears it", async () => {
    await replaceCredentialSecret(owner(), S.kept!, { secret: { password: "brand-new-1" } });
    expect(await marked(S.kept!)).toBe(true);
    await replaceCredentialSecret(owner(), S.kept!, { secret: { password: "brand-new-2" }, totp: SEED_THREE });
    expect(await marked(S.kept!)).toBe(false);
  });

  it("a seed changed after the export — or no seed at all — holds no mark", async () => {
    await replaceCredentialSecret(owner(), S.reseeded!, { secret: { password: "fresh-1" } });
    expect(await marked(S.reseeded!)).toBe(false);
    await replaceCredentialSecret(owner(), S.plain!, { secret: { password: "fresh-2" } });
    expect(await marked(S.plain!)).toBe(false);
  });

  it("the hint's two saves — every field first, then the key — clear the mark (the fix-round review)", async () => {
    await replaceCredentialSecret(owner(), S.twoSaves!, { secret: { password: "two-1" } });
    expect(await marked(S.twoSaves!)).toBe(true);
    const held = (await f.audits("credential.updated")).filter((a) => a.targetId === S.twoSaves).at(-1);
    expect(held?.metadata).toMatchObject({ heldBySeed: true });
    await replaceCredentialSecret(owner(), S.twoSaves!, { totp: SEED_THREE });
    expect(await marked(S.twoSaves!)).toBe(false);
  });

  it("a removal between the two saves voids the first — every new value then goes in one save", async () => {
    await replaceCredentialSecret(owner(), S.voided!, { secret: { password: "void-1" } });
    expect(await marked(S.voided!)).toBe(true);
    // Somebody leaves in between — who may have seen the new password, and whose
    // removal writes no flag row for a login already marked.
    const bystander = await memberWith("bystander", ["credential:view"]);
    await suspendMember({ tenantId: f.tenantId, actor: owner().actor, memberId: bystander });
    await replaceCredentialSecret(owner(), S.voided!, { totp: SEED_THREE });
    expect(await marked(S.voided!)).toBe(true);
    await replaceCredentialSecret(owner(), S.voided!, { secret: { password: "void-2" }, totp: SEED_TWO });
    expect(await marked(S.voided!)).toBe(false);
  });

  it("an exporter who still works here holds no mark", async () => {
    const id = (
      await createCredential(owner(), { clientId: null, type: "LOGIN", name: "Owner exported", secret: { password: "o-pw" }, totp: TOTP_SEED })
    ).id;
    await exportCredentials(owner(), { kind: "agency" }, LABELS);
    await f.platform.credentialItem.update({ where: { id }, data: { needsRotation: true } });
    await replaceCredentialSecret(owner(), id, { secret: { password: "o-new" } });
    expect(await marked(id)).toBe(false);
  });
});

describe("an export counts as knowing every exported secret (C63 (d))", () => {
  it("removing a member who exported a client flags exactly that client's logins", async () => {
    await f.platform.credentialItem.updateMany({ where: { tenantId: f.tenantId }, data: { needsRotation: false } });
    await exportCredentials(ctxOf(actorFor(secondOwner)), { kind: "client", clientId: beta }, LABELS);
    const { flagged } = await suspendMember({ tenantId: f.tenantId, actor: owner().actor, memberId: secondOwner });
    expect(flagged).toBe(1);
    const marked = await f.platform.credentialItem.findMany({ where: { tenantId: f.tenantId, needsRotation: true }, select: { id: true } });
    expect(marked.map((m) => m.id)).toEqual([L.beta]);
  });

  it("an export waiting on the member's reveal key while they are removed is refused once it gets it — no file, row or mail", async () => {
    const key = `vault_reveal:${f.tenantId}:${racer}`;
    const audits = (await exportedRows()).length;
    const mails = (await outboxOf()).length;
    let pending: Promise<string> | undefined;
    try {
      // Stands in for a removal: hold the member's key, let the export pass
      // every gate before it and park on the key, then commit the suspension.
      await f.platform.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
          pending = outcome(exportCredentials(ctxOf(actorFor(racer)), ALL, LABELS));
          pending.catch(() => undefined);
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const [row] = await f.platform.$queryRaw<{ n: number }[]>`
              SELECT count(*)::int AS n FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted
                AND objid::text::bigint = (hashtext(${key})::bigint & 4294967295)`;
            if ((row?.n ?? 0) > 0) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          await tx.member.update({ where: { id: racer }, data: { status: "SUSPENDED", suspendedAt: new Date() } });
        },
        { timeout: 30_000 },
      );
      expect(await pending).toBe("FORBIDDEN:the member is no longer active");
    } finally {
      await f.platform.member.update({ where: { id: racer }, data: { status: "ACTIVE", suspendedAt: null } });
    }
    expect((await exportedRows()).length).toBe(audits);
    expect((await outboxOf()).length).toBe(mails);
  }, 60_000);
});

describe("a removal and a change of an already-marked login cannot both pass each other by (the fix-round review)", () => {
  it("the removal waits for the change's row lock, and marks the login again once the change has cleared it", async () => {
    const x = await memberWith("xleaver", ["credential:view", "credential:reveal", "client:view_all"]);
    const id = (await createCredential(owner(), { clientId: null, type: "LOGIN", name: "Raced mark", secret: { password: "r-pw" } })).id;
    await revealCredentialField(ctxOf(actorFor(x)), id, "password");
    // Marked already, by an earlier leaver.
    await f.platform.credentialItem.update({ where: { id }, data: { needsRotation: true } });
    let pending: Promise<unknown> | undefined;
    // Stands in for a change that clears the mark: it holds the login's row,
    // and before it commits, x's removal begins. Unlocked, the removal would
    // skip the login as "already marked" on its own snapshot.
    await f.platform.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM credential_item WHERE id = ${id} FOR UPDATE`;
        await tx.credentialItem.update({ where: { id }, data: { needsRotation: false } });
        pending = suspendMember({ tenantId: f.tenantId, actor: owner().actor, memberId: x });
        pending.catch(() => undefined);
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const [row] = await f.platform.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple')`;
          if ((row?.n ?? 0) > 0) break;
          await new Promise((r) => setTimeout(r, 50));
        }
      },
      { timeout: 30_000 },
    );
    await pending;
    expect(await f.platform.credentialItem.findUniqueOrThrow({ where: { id }, select: { needsRotation: true } })).toEqual({ needsRotation: true });
    const flagged = (await f.audits("credential.rotation_flagged")).filter((a) => a.targetId === id);
    expect(flagged.at(-1)?.metadata).toMatchObject({ memberId: x });
  }, 60_000);
});

describe("an export is dated after it READ the seed (the fix-round review)", () => {
  it("a seed change committed while the export waited is the seed in the file — its exporter, gone, still holds the mark", async () => {
    const exporter = await memberWith("lateread", ["credential:view", "credential:reveal", "credential:export", "client:view_all"]);
    const id = (
      await createCredential(owner(), { clientId: null, type: "LOGIN", name: "Read late", secret: { password: "late-pw" }, totp: TOTP_SEED })
    ).id;
    const key = `vault_reveal:${f.tenantId}:${exporter}`;
    let pending: Promise<unknown> | undefined;
    // Hold the exporter's reveal key: the export's transaction has begun and
    // waits; meanwhile the seed is changed and committed; then the export goes
    // on, reads the NEW seed, and writes its rows — dated at that insert.
    await f.platform.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
        pending = exportCredentials(ctxOf(actorFor(exporter)), { kind: "agency" }, LABELS);
        pending.catch(() => undefined);
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const [row] = await f.platform.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND objid::text::bigint = (hashtext(${key})::bigint & 4294967295)`;
          if ((row?.n ?? 0) > 0) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        await replaceCredentialSecret(owner(), id, { totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" });
      },
      { timeout: 30_000 },
    );
    await pending;
    const row = (await exportedRows()).filter((a) => a.targetId === id && a.actorId === exporter).at(-1)!;
    const seedChange = (await f.audits("credential.updated")).filter((a) => a.targetId === id).at(-1)!;
    // The export's transaction began BEFORE the seed change, yet its row is
    // dated after it: an audit row is stamped at its insert, which the export
    // makes after its read — the order `seedTakenByLeaver` relies on.
    expect(row.createdAt.getTime()).toBeGreaterThan(seedChange.createdAt.getTime());
    expect(row.metadata).toMatchObject({ seed: true });
    await suspendMember({ tenantId: f.tenantId, actor: owner().actor, memberId: exporter });
    await replaceCredentialSecret(owner(), id, { secret: { password: "late-new" } });
    expect(await f.platform.credentialItem.findUniqueOrThrow({ where: { id }, select: { needsRotation: true } })).toEqual({ needsRotation: true });
  }, 60_000);
});

describe("a leaver's own save, made while their removal waits, cannot finish a held mark later (the third review)", () => {
  it("the removal's row postdates the save it waited on, so a later seed change alone leaves the mark", async () => {
    const x = await memberWith("xsaver", ["credential:view", "credential:edit", "credential:reveal", "client:view_all"]);
    const id = (
      await createCredential(owner(), { clientId: null, type: "LOGIN", name: "Saved on the way out", secret: { password: "s-pw" }, totp: TOTP_SEED })
    ).id;
    // Marked by an earlier leaver, as the offboarding flags would mark it.
    await f.platform.credentialItem.update({ where: { id }, data: { needsRotation: true } });
    await f.platform.auditEvent.create({
      data: {
        tenantId: f.tenantId,
        actorType: "MEMBER",
        actorId: f.seats.owner.memberId,
        action: "credential.rotation_flagged",
        targetType: "CredentialItem",
        targetId: id,
        metadata: { memberId: randomUUID(), cause: "member_removed" },
        visibility: "TENANT",
        createdAt: new Date(Date.now() - 60 * 60_000),
      },
    });
    const key = `vault_reveal:${f.tenantId}:${x}`;
    let pending: Promise<unknown> | undefined;
    // Hold x's reveal key, as x's own save would: x's removal begins and waits
    // on it; meanwhile x's save lands — every field new, held back by a taken
    // seed (`heldBySeed`) — and commits; then the removal goes on.
    await f.platform.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
        pending = suspendMember({ tenantId: f.tenantId, actor: owner().actor, memberId: x });
        pending.catch(() => undefined);
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const [row] = await f.platform.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND objid::text::bigint = (hashtext(${key})::bigint & 4294967295)`;
          if ((row?.n ?? 0) > 0) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        await tx.auditEvent.create({
          data: {
            tenantId: f.tenantId,
            actorType: "MEMBER",
            actorId: x,
            action: "credential.updated",
            targetType: "CredentialItem",
            targetId: id,
            metadata: { secretChanged: true, changedFields: ["password"], rotated: true, totpChanged: false, fields: ["password"], hasTotp: true, heldBySeed: true },
            visibility: "TENANT",
          },
        });
      },
      { timeout: 30_000 },
    );
    await pending;
    const held = (await f.audits("credential.updated")).filter((a) => a.targetId === id).at(-1)!;
    const removed = (await f.audits("member.suspended")).filter((a) => a.targetId === x).at(-1)!;
    expect(removed.createdAt.getTime()).toBeGreaterThan(held.createdAt.getTime());
    // x typed the current password on the way out: a new seed alone must not clear the mark.
    await replaceCredentialSecret(owner(), id, { totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" });
    expect(await f.platform.credentialItem.findUniqueOrThrow({ where: { id }, select: { needsRotation: true } })).toEqual({ needsRotation: true });
  }, 60_000);
});
