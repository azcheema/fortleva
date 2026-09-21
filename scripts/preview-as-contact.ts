// Dev helper: an RLS ROW-LEVEL probe, terminal edition.
//
// Reads under a real contact principal — withTenant(tenantId,
// {type:"contact", ...}) — so Postgres RLS (the portal_gate policies)
// does the filtering, not application code. What it answers is "which
// ROWS would this client's principal be admitted to", across more
// tables than the product yet projects: projects, milestones, versions,
// documents, services, plus a cross-client probe that must always be
// zero.
//
//   pnpm exec tsx scripts/preview-as-contact.ts                 # list clients
//   pnpm exec tsx scripts/preview-as-contact.ts --client Acme
//
// **IT IS NOT "VIEW AS CLIENT", AND SINCE 2026-09-21 THAT IS A REAL
// DISTINCTION RATHER THAN A PEDANTIC ONE.** The product has the genuine
// article now — `/view-as` (Phase 3 slice 5), which runs the CONTACT'S
// OWN projection functions under a synthesised principal and is
// byte-compared against a real contact session in CI. This file's
// earlier header promised that screens would arrive "when View as
// Contact becomes a button"; they have, and this is not them.
//
// The difference is the one the pins care about: RLS filters ROWS, not
// COLUMNS. The reads below are hand-written `select`s that happen to
// omit the sensitive columns, and NOTHING enforces that they keep doing
// so — the projection tripwires (`src/authz/portal-projections.test.ts`)
// walk `src/`, and this file is in `scripts/`. So:
//
//   • Use it to answer "is my RLS doing what I think?".
//   • NEVER cite it as evidence about what a client can SEE. That
//     question is answered by `modules/*/portal.ts` and by `/view-as`,
//     which are allow-listed and tested.
//
// It also previews with a SYNTHETIC contact id when the client has none
// yet — useful here, and the opposite of what the product does, which
// refuses to view as anybody who could not actually sign in.
import { randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const bullet = (n: number, singular: string, plural = `${singular}s`) =>
  `${n} ${n === 1 ? singular : plural}`;

async function main() {
  const tenantSlug = flag("tenant") ?? "naxdor";
  const wanted = flag("client");

  const { getPlatformClient } = await import("../src/db/client");
  const { withTenant } = await import("../src/db");
  const platform = getPlatformClient();

  const tenant = await platform.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) throw new Error(`no tenant "${tenantSlug}"`);

  const clients = await platform.client.findMany({
    where: { tenantId: tenant.id },
    select: { id: true, name: true, status: true },
    orderBy: { name: "asc" },
  });
  if (clients.length === 0) throw new Error(`no clients in ${tenantSlug} yet`);

  const client =
    clients.find((c) => c.id === wanted) ??
    clients.find((c) => c.name.toLowerCase() === (wanted ?? "").toLowerCase());

  if (!client) {
    console.log(`clients in ${tenant.name}:\n`);
    for (const c of clients) console.log(`  ${c.name}${c.status === "ARCHIVED" ? " (archived)" : ""}`);
    console.log(`\nre-run with --client "<name>"`);
    await platform.$disconnect();
    return;
  }

  // Ground truth (platform role bypasses RLS) — for the contrast.
  const [allProjects, allMilestones, allVersions, allDocs, allServices] = await Promise.all([
    platform.project.findMany({
      where: { tenantId: tenant.id, clientId: client.id },
      select: { id: true, key: true, name: true, status: true, portalEnabled: true },
      orderBy: { key: "asc" },
    }),
    platform.milestone.count({ where: { tenantId: tenant.id, clientId: client.id } }),
    platform.projectVersion.count({ where: { tenantId: tenant.id, clientId: client.id } }),
    platform.document.count({ where: { tenantId: tenant.id, clientId: client.id, deletedAt: null } }),
    platform.service.count({ where: { tenantId: tenant.id, clientId: client.id } }),
  ]);

  const contact = await platform.contact.findFirst({
    where: { tenantId: tenant.id, clientId: client.id },
    select: { id: true, name: true, email: true, portalProfile: true },
    orderBy: { createdAt: "asc" },
  });

  // The principal Phase 3 will build sessions for. RLS gates key on
  // app.client_id, so a synthetic id previews correctly when the client
  // has no Contact record yet.
  const principal = {
    type: "contact" as const,
    id: contact?.id ?? randomUUID(),
    clientId: client.id,
  };

  const seen = await withTenant(tenant.id, principal, async (tx) => {
    const [projects, milestones, versions, documents, services, otherClients] = await Promise.all([
      tx.project.findMany({
        select: { key: true, name: true, status: true, startDate: true, launchDate: true, productionUrl: true },
        orderBy: { key: "asc" },
      }),
      tx.milestone.findMany({
        select: { name: true, status: true, dueAt: true, projectId: true },
        orderBy: { rank: "asc" },
      }),
      tx.projectVersion.findMany({
        select: { version: true, title: true, shippedAt: true },
        orderBy: { shippedAt: "desc" },
      }),
      tx.document.findMany({
        where: { deletedAt: null },
        select: { name: true, kind: true },
        orderBy: { createdAt: "desc" },
      }),
      tx.service.findMany({ select: { name: true, kind: true, status: true } }),
      // Cross-client probe: must always be zero.
      tx.client.findMany({ select: { id: true, name: true } }),
    ]);
    return { projects, milestones, versions, documents, services, otherClients };
  });

  const keyOf = new Map(allProjects.map((p) => [p.id, p.key]));
  const line = "─".repeat(58);

  console.log(`\n${line}`);
  console.log(`WHAT ${client.name.toUpperCase()} WOULD SEE IN THE PORTAL`);
  console.log(`tenant: ${tenant.name}   contact: ${contact ? `${contact.name} <${contact.email}> (${contact.portalProfile})` : "none yet — previewing with a synthetic contact"}`);
  console.log(line);

  console.log(`\nPROJECTS (${seen.projects.length} of ${allProjects.length})`);
  if (seen.projects.length === 0) console.log("  — nothing: no project has the portal switch on");
  for (const p of seen.projects) {
    console.log(`  ${p.key}  ${p.name}  [${p.status}]${p.productionUrl ? `  ${p.productionUrl}` : ""}`);
  }

  console.log(`\nMILESTONES (${seen.milestones.length} of ${allMilestones})`);
  for (const m of seen.milestones) {
    const due = m.dueAt ? ` · due ${m.dueAt.toISOString().slice(0, 10)}` : "";
    console.log(`  ${keyOf.get(m.projectId) ?? "?"}  ${m.name}  [${m.status}]${due}`);
  }
  if (seen.milestones.length === 0) console.log("  — none marked \"Client can see\"");

  console.log(`\nSHIPPED VERSIONS (${seen.versions.length} of ${allVersions})`);
  for (const v of seen.versions) {
    console.log(`  ${v.version}${v.title ? ` — ${v.title}` : ""}  ${v.shippedAt?.toISOString().slice(0, 10) ?? ""}`);
  }
  if (seen.versions.length === 0) console.log("  — none shipped yet (drafts stay internal)");

  console.log(`\nFILES (${seen.documents.length} of ${allDocs})`);
  for (const d of seen.documents) console.log(`  ${d.name}  [${d.kind}]`);
  if (seen.documents.length === 0) console.log("  — none marked \"Client can see\"");

  console.log(`\nSERVICES (${seen.services.length} of ${allServices})`);
  for (const s of seen.services) console.log(`  ${s.name}  [${s.kind}/${s.status}]`);

  console.log(`\nISOLATION PROBE`);
  const leaked = seen.otherClients.filter((c) => c.id !== client.id);
  console.log(`  company records readable: ${bullet(seen.otherClients.length, "row")}` +
    (leaked.length ? `  ⚠ LEAK: ${leaked.map((c) => c.name).join(", ")}` : "  ✓ only their own"));

  console.log(`\nHIDDEN FROM THE CLIENT`);
  console.log(`  ${bullet(allProjects.length - seen.projects.length, "project")} (portal off), ` +
    `${bullet(allMilestones - seen.milestones.length, "milestone")}, ` +
    `${bullet(allVersions - seen.versions.length, "version")} (drafts), ` +
    `${bullet(allDocs - seen.documents.length, "file")}`);
  console.log(`  plus every internal column (client notes, repo/hosting, internal notes)`);
  console.log(`  — those are guarded by the portal projections in Phase 3.`);
  console.log(`${line}\n`);

  await platform.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
