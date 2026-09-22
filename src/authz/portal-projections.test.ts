import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Forbidden-columns grep (plan §3.2, PLAN.md Phase 2 non-negotiable
 * test): no portal projection may select an INTERNAL-only column. A
 * "portal projection" is any `src/**\/portal.ts` module (the allow-listed
 * selects Phase 3 introduces; view-as-Contact reuses the same
 * functions).
 *
 * **`portal-writes.ts` is scanned too, and it had to be added** (security
 * review, 2026-09-20). The founder decision of 2026-09-20 splits brokered
 * writes out of `portal.ts` into `portal-writes.ts` precisely so that
 * "this code runs as system" is a property of a filename a reviewer
 * cannot miss — and this walk matched the name `portal.ts` exactly, so
 * the first such file would have been the first contact-facing module
 * never scanned for a forbidden column. The split made the file MORE
 * dangerous and less watched at the same time.
 *
 * **AND SINCE 2026-09-21 A NAME LIST IS NOT THE WHOLE TEST.** The Phase 3
 * decision memo (§2.2) asks for exactly this and it is worth
 * over-honouring: *"I would want the grep test to fail on a `select`
 * that is not an explicit allow-list at all, not merely on known-bad
 * column names — a new internal column added next year is not in today's
 * forbidden list."* The second half of this file is that check. The list
 * below stays because it is cheap, because it catches a column named in
 * a COMMENT or reached through a helper, and because reviewing it every
 * phase is how the never-list stays current — but the structural check
 * is the one that holds when nobody remembers to.
 */

export const PORTAL_FORBIDDEN_COLUMNS = [
  "internalNotes",
  "repoUrl",
  "hostingNotes",
  "leadMemberId",
  "billRate",
  "cost",
  "assigneeMemberId",
  // Phase 3 slice 6c: the CONTACT assignee's NAME. `assigneeContactId`
  // cannot join this list — `portal.ts` must read the column to build
  // `assignedToYou` — but the NAME is the half that identifies a
  // person, and UI.md §11's rule is that the portal list says which
  // tasks are YOURS and never which are a colleague's. The slice that
  // minted it put it on `ItemListEntry` and `ItemDetail`, the two shapes
  // a portal projection is likeliest to copy from; without this line the
  // portal half could carry the column across with both tiers green.
  "assigneeContactName",
  // 2W (2026-09-12): the work tables. The portal sees state CATEGORIES,
  // never a tenant's own state names or ids; no priority, no estimate,
  // no label, and no member id on a history row or a comment — the
  // portal never names a member in v1.
  "stateId",
  "stateName",
  "priority",
  "estimateMinutes",
  "remainingMinutes",
  "labelId",
  // The list projection's chip array (2026-09-16, labels on the card
  // and the row): a label is on the never-list, and `labels` is not
  // `labelId`, so the identifier grep would have walked past the one
  // shape a portal task list would most plausibly reach for.
  "labels",
  // ...and the join table's own delegate, which a projection reading
  // labels directly (`tx.workItemLabel.findMany`) names instead of either
  // field (security review, 2026-09-16). Bare `label` is deliberately NOT
  // listed: every UI projection has a `label:` key, so it would fail for
  // the wrong reason and teach people to ignore this test.
  "workItemLabel",
  // ...and the two readers labels.ts keeps off the barrel, because a
  // projection that imported one from `./labels` directly and renamed the
  // result would name none of the three above (delta review).
  "readLabelsByItem",
  "readItemLabels",
  "actorMemberId",
  "authorMemberId",
  "createdByMemberId",
  "oldRef",
  "newRef",
  // Phase 3 slice 2 handed this one over by name (PLAN §0, "what slice 3
  // inherits"): `portal_gate` on `contact` is STRUCTURAL — client match
  // only, no visibility term — so a contact can read every contact row of
  // its own client, and `Contact.invitedById` is a MEMBER id sitting on
  // one of them. RLS grants the row; the projection owns the columns, and
  // this is the column. It is the first entry here that guards a table
  // whose rows a contact is *supposed* to see.
  "invitedById",
] as const;

const SRC = join(__dirname, "..");
const SCHEMA = join(__dirname, "..", "..", "prisma", "schema.prisma");

/**
 * WHAT COUNTS AS A PORTAL SURFACE — and this used to be a list of two
 * FILENAMES, which the security review of this slice showed was not
 * enough (2026-09-21).
 *
 * Nothing in the codebase forces a portal page to read through a
 * `portal.ts`. ESLint confines `@/db/client`, `withPlatform` and
 * `portalAuthClient`, but `withPortalRead` is importable anywhere, and
 * UI.md §11's "portal reads use only `modules/*\/portal.ts` projections"
 * is prose. So a `/portal/projects/[id]/page.tsx` written next slice as
 * `withPortalRead(p, (tx) => tx.workItem.findMany({ where: { projectId } }))`
 * would have handed the client every column of every CLIENT_VISIBLE row
 * — the ProseMirror body, the rank, the estimate, the member id — while
 * both halves of this test stayed green, because no file named
 * `portal.ts` was touched. **RLS filters ROWS, not COLUMNS.** The
 * tripwire has to follow the capability, not the filename.
 *
 * Three ways in, so a new surface is caught by whichever it trips first:
 *   • the two conventional names, anywhere under src;
 *   • everything under the portal route group;
 *   • any file that so much as mentions `withPortalRead` — which is the
 *     one that follows the capability rather than a convention.
 *
 * TESTS ARE EXCLUDED, and deliberately rather than for convenience: a
 * dbtest's whole job is to name the hazard and measure it.
 * `portal.dbtest.ts` selects `Contact.invitedById` on purpose, to prove
 * the policy really hands a contact its colleague's row — scanning it
 * would fail this test for doing the right thing.
 */
const PORTAL_ROUTES = join("app", "(portal)");

/**
 * TWO SCOPES, BECAUSE THE TWO TIERS CAN AFFORD DIFFERENT ONES — and the
 * first cut of this widening proved it by going red on a comment.
 *
 * The TEXT grep matches a bare identifier anywhere in a file, prose
 * included. `src/portal/authorize.ts` says "at the cost of a WeakSet
 * lookup rather than a round trip", and `cost` is on the never-list, so
 * scanning the whole widened set failed the build over a sentence. That
 * is the same failure this file already records for bare `label`: a test
 * that goes red for the wrong reason teaches people to ignore it. So the
 * grep keeps to code whose job IS projecting — the two conventional
 * names and the portal routes, which are render code with no room for a
 * paragraph about round trips.
 *
 * The STRUCTURAL check has no such problem: it fires on an actual select
 * KEY, never on prose, so it runs over every portal surface including
 * the seam itself. That is the scope the security review asked for, and
 * it is the tier that would have caught the leak it described.
 */
/**
 * A FOURTH WAY IN, added 2026-09-21 after a security review pointed out
 * that the widening's own stated principle had already been broken by
 * the slice that wrote it.
 *
 * `src/projects/portal-preview.ts` is the member plane's "what the
 * client sees": it synthesises a contact principal and renders portal
 * output. It is named `portal-preview.ts`, not `portal.ts`; it lives
 * outside `(portal)`; and it never mentions `withPortalRead`, because it
 * calls `listPortalTasks`, which does. So all three arms missed it —
 * the one file in the product that is a portal surface by CAPABILITY
 * and by no convention at all, which is exactly the case the header
 * above says this walk must follow.
 *
 * It is listed by name rather than by a `portal-*` glob: the point is a
 * closed set a reviewer can read, and a glob would quietly enrol
 * whatever someone names next. It is in the TEXT tier too — verified
 * clean of every forbidden identifier when it was added, prose included,
 * so it cannot go red for the wrong reason the way the first widening
 * did on the word "cost".
 */
const PORTAL_SURFACES_BY_NAME = [
  join("projects", "portal-preview.ts"),
  // `src/clients/view-as.ts` — View-as-Contact's service (slice 5). The
  // same case one slice on: it is named neither `portal.ts` nor
  // `portal-writes.ts`, lives outside `(portal)` and outside the
  // `view-as` ROUTE group the AST tier now walks, and never mentions
  // `withPortalRead` because it calls `listPortalTasks`, which does.
  // What it DOES read is the CONTACT row — PII on a member surface, and
  // the one table where a later `include`, `omit` or select-less
  // `findFirst` would pull an email onto a screen (security review).
  // Verified clean of all 21 forbidden identifiers, prose included, when
  // it was added, so it cannot go red for the wrong reason.
  join("clients", "view-as.ts"),
];

/**
 * A FIFTH WAY IN — and it is STRUCTURAL ONLY, which is the whole point
 * of listing it separately (Phase 3 slice 5, 2026-09-21).
 *
 * `src/app/(tenant)/view-as/` is View-as-Contact: a MEMBER-plane route
 * group that renders the portal's own components under a synthesised
 * contact principal. By the capability rule this header states, it is a
 * portal surface — a `/view-as/projects/[id]` written next slice as a
 * select-less `findMany` would hand a member's screen every column of
 * every row, and no arm above would see it, because it is not named
 * `portal.ts`, not under `(portal)`, and mentions `withPortalRead`
 * nowhere.
 *
 * IT IS DELIBERATELY NOT IN THE TEXT TIER, and the reason is measured
 * rather than assumed. Slice 46 widened the identifier grep over every
 * portal surface and it went red immediately — on the word `cost` in a
 * sentence in `src/portal/authorize.ts` — which is the failure this
 * file already records for bare `label`: *a test that goes red for the
 * wrong reason teaches people to ignore it*. `view-as/actions.ts`
 * carries the same word in prose today ("a small, known cost"). So the
 * grep keeps to code whose job IS projecting, and the AST check — which
 * fires on an actual select KEY and never on a paragraph — takes this.
 */
const VIEW_AS_ROUTES = join("app", "(tenant)", "view-as");

/**
 * A SIXTH WAY IN, STRUCTURAL ONLY, for the same reason as `view-as`
 * above (Phase 3 slice 6a, 2026-09-21).
 *
 * `src/modules/work/requests.ts` performs the contact-caused INSERT and
 * derives the row's `client_id`. The brokered writer next door delegates
 * to it precisely BECAUSE this file's text grep forbids a portal surface
 * from naming `stateId` — and a create that lands a row in a workflow
 * state has to name one. That split is deliberate and keeps the
 * forbidden list absolute, but a code review put the consequence
 * plainly: it left the file doing the actual write outside BOTH tiers,
 * so a select-less `findFirst`, an `include`, or a helper returning a
 * member id added there when the triage verb lands would trip nothing.
 *
 * So it joins the AST tier, which fires on real select KEYS and never on
 * a paragraph, and stays out of the TEXT tier, whose list its prose
 * necessarily spells out. That is the same trade, for the same reason,
 * that `view-as` already records.
 */
const STRUCTURAL_ONLY_SURFACES = [
  join("modules", "work", "requests.ts"),
  // …and `triage.ts` (slice 6b, 2026-09-22), for the reason the
  // paragraph above PREDICTED: "a select-less `findFirst`, an
  // `include`, or a helper returning a member id added there **when the
  // triage verb lands** would trip nothing." It landed. The file also
  // earns it on its own: it authors `triage_reason`, the only string in
  // this product a MEMBER writes and a CONTACT reads, so a projection
  // mistake there reaches a client's screen directly. Structural tier
  // only, like `requests.ts` and `view-as`, because its prose
  // necessarily spells out the text tier's own list.
  join("modules", "work", "triage.ts"),
];

/**
 * **THE MEMBER-PLANE READ THAT SITS OUTSIDE THE TIER ON PURPOSE, and
 * the closed set of files allowed to reach it** (security review,
 * 2026-09-22).
 *
 * `src/modules/work/triage-lane.ts` is the first file in this repo
 * created DELIBERATELY outside the structural tier. It holds
 * `listTriage`, which selects `descriptionText` and `snoozedUntil` —
 * both legitimate on the member plane and both on `PORTAL_NEVER_SELECTED`
 * — so it could not live in `triage.ts`, which the previous commit put
 * in the tier because it authors the one member-written string a contact
 * reads.
 *
 * The split is sound: `WorkCtx.actor` is a `MemberActor` and
 * `principalOf` always yields a member principal, so that transaction
 * can never open under a contact. But the review's accounting was right
 * that coverage went DOWN and prose is not a guard — this file's own
 * header records that UI.md's "portal reads use only a module's own `portal.ts`"
 * was prose and did not hold. `portal-preview.ts` and `clients/view-as.ts`
 * are both MEMBER-plane files that render portal output, so "a
 * member-plane read feeding a client-facing preview" is a shape this
 * product already has; a "what the client sees for triage" view written
 * next slice would reach this module and trip nothing.
 *
 * So the set is pinned, the way `portal-view-as.test.ts` pins who may
 * build a `PortalPrincipal`. Adding a file here is the reviewable
 * moment: if the new caller is a portal surface, the read belongs in a
 * `portal.ts` with an allow-listed select instead.
 */
const LANE_READ = join("modules", "work", "triage-lane.ts");
const LANE_READERS = [
  // The member-plane page it exists for.
  join("app", "(tenant)", "(authed)", "projects", "[key]", "triage", "page.tsx"),
  // The module barrel (ARC-16 routes every cross-module import through it).
  join("modules", "work", "index.ts"),
];

const isProjection = (full: string, entry: string): boolean =>
  entry === "portal.ts" ||
  entry === "portal-writes.ts" ||
  full.includes(PORTAL_ROUTES) ||
  PORTAL_SURFACES_BY_NAME.some((suffix) => full.endsWith(suffix));

const isPortalSurface = (full: string, entry: string, text: () => string): boolean =>
  isProjection(full, entry) ||
  full.includes(VIEW_AS_ROUTES) ||
  STRUCTURAL_ONLY_SURFACES.some((suffix) => full.endsWith(suffix)) ||
  text().includes("withPortalRead");

const walk = (
  dir: string,
  include: (full: string, entry: string, text: () => string) => boolean,
  out: string[] = [],
): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "generated" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, include, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    // A test names the hazard on purpose — `portal.dbtest.ts` selects
    // `Contact.invitedById` to prove the policy really hands a contact
    // its colleague's row — so scanning one would fail this for doing
    // the right thing.
    if (entry.endsWith(".test.ts") || entry.endsWith(".dbtest.ts") || entry.endsWith(".test.tsx")) {
      continue;
    }
    if (include(full, entry, () => readFileSync(full, "utf8"))) out.push(full);
  }
  return out;
};

const identifierRe = (name: string) => new RegExp(`(^|[^A-Za-z0-9_$])${name}([^A-Za-z0-9_$]|$)`);

describe("portal projections never touch INTERNAL-only columns", () => {
  it("the forbidden list is pinned", () => {
    expect([...PORTAL_FORBIDDEN_COLUMNS]).toEqual([
      "internalNotes",
      "repoUrl",
      "hostingNotes",
      "leadMemberId",
      "billRate",
      "cost",
      "assigneeMemberId",
      "assigneeContactName",
      "stateId",
      "stateName",
      "priority",
      "estimateMinutes",
      "remainingMinutes",
      "labelId",
      "labels",
      "workItemLabel",
      "readLabelsByItem",
      "readItemLabels",
      "actorMemberId",
      "authorMemberId",
      "createdByMemberId",
      "oldRef",
      "newRef",
      "invitedById",
    ]);
  });

  /**
   * THE SECOND LIST GETS THE SAME PIN, and it did not have one until
   * slice 6b's security review pointed that out.
   *
   * `PORTAL_FORBIDDEN_COLUMNS` has been pinned by the assertion above
   * since it was written; `PORTAL_NEVER_SELECTED` — the AST tier's list,
   * the one that catches `select: { rank: true }` — had nothing. A name
   * quietly deleted from it would weaken the tripwire with no test
   * failing anywhere, which is precisely the property this file exists
   * to deny to everyone else.
   *
   * It matters more since 6b: `duplicateOfId` sits on this list and is
   * written over real data for the first time, so it is now a column
   * with something to leak rather than a reserved name.
   */
  it("only the sanctioned member-plane files read the triage lane", () => {
    // ON THE IMPORT SPECIFIER, never on the text. The first cut of this
    // matched any file MENTIONING `triage-lane` or `listTriage` and
    // caught two innocents — a sentence in `notify.ts` and a
    // `data-testid` on the lane's own component — which is this file's
    // own standing lesson about text-tier matching, applied to itself.
    // `walk` already skips generated code and every test file.
    const readers = walk(
      SRC,
      (full, _entry, text) =>
        relative(SRC, full) !== LANE_READ && /from\s+["'][^"']*triage-lane["']/.test(text()),
    )
      .map((file) => relative(SRC, file))
      .sort();
    expect(readers, "a new reader of listTriage is a decision, not a detail").toEqual(
      [...LANE_READERS].sort(),
    );
  });

  it("PORTAL_NEVER_SELECTED is pinned — a name may not quietly leave it", () => {
    expect([...PORTAL_NEVER_SELECTED].sort()).toEqual(
      [
        "rank",
        "priority",
        "type",
        "kind",
        "stateId",
        "triageStatus",
        "snoozedUntil",
        "duplicateOfId",
        "estimateMinutes",
        "remainingMinutes",
        "startedAt",
        "description",
        "descriptionText",
        "assigneeMemberId",
        "createdByMemberId",
        "leadMemberId",
        "actorMemberId",
        "authorMemberId",
        "invitedById",
        "sourceSystem",
        "sourceId",
        "importJobId",
        "internalNotes",
        "repoUrl",
        "hostingNotes",
      ].sort(),
    );
  });

  it("no portal projection mentions a forbidden column", () => {
    const files = walk(SRC, isProjection);
    const offences: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const col of PORTAL_FORBIDDEN_COLUMNS) {
        if (identifierRe(col).test(text)) offences.push(`${relative(SRC, file)}: ${col}`);
      }
    }
    expect(offences).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────
 * THE STRUCTURAL HALF: every read is an explicit allow-list.
 * ──────────────────────────────────────────────────────────────────── */

/**
 * The schema, read as TEXT rather than through the client. Prisma 7 has
 * no runtime DMMF (`src/db/model-registry.ts` records the same problem
 * and answers it with a checked constant), and this test must run in the
 * unit suite — no `DATABASE_URL`, no generated-client import, no
 * connection. What it needs is small: which models exist, and for each
 * field whether it is a SCALAR or a RELATION, and to what.
 *
 * A field's type is a relation exactly when it names another model. That
 * is the whole rule, and it is what makes `project: true` detectable:
 * `select: { project: true }` returns every column of the project row,
 * including the ones on the never-list, while looking exactly like a
 * scalar pick.
 */
type Field = { readonly name: string; readonly relationTo: string | null };
type Model = { readonly fields: ReadonlyMap<string, Field> };

function parseSchema(text: string): ReadonlyMap<string, Model> {
  const blocks = [...text.matchAll(/^model\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)^\}/gm)];
  const names = new Set(blocks.map((b) => b[1]!));
  const models = new Map<string, Model>();
  for (const block of blocks) {
    const fields = new Map<string, Field>();
    for (const line of block[2]!.split("\n")) {
      const trimmed = line.trim();
      // Attributes (`@@index`), comments and blanks are not fields.
      if (!trimmed || trimmed.startsWith("@@") || trimmed.startsWith("//")) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
      if (!m) continue;
      const [, name, type] = m as unknown as [string, string, string];
      fields.set(name, { name, relationTo: names.has(type) ? type : null });
    }
    models.set(block[1]!, { fields });
  }
  return models;
}

/** `workItem` → `WorkItem`. Prisma's delegate is the model name with a
 *  lower-cased first character, so this inverts exactly. */
const modelOfDelegate = (delegate: string) => delegate.charAt(0).toUpperCase() + delegate.slice(1);

/**
 * Methods nothing but Prisma has. A call to one of these IS a row read,
 * whatever the receiver looks like — which is what lets an unresolvable
 * delegate below be an offence rather than a silent skip.
 */
const PRISMA_ONLY = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "createManyAndReturn",
  "updateManyAndReturn",
  "upsert",
]);

/**
 * Writes that can RETURN a row — and whose names JavaScript also uses.
 * `Object.create(null)` is in AGENTS.md's own ProseMirror trap,
 * `map.delete(tx)` and `hash.update(buf)` are ordinary code, and this
 * walk now covers files that are not projections at all
 * (`src/auth/portal.ts` is a Better Auth config). So these count only
 * when the receiver resolves to a real Prisma model — otherwise an
 * unrelated edit would fail this test with a message about allow-lists.
 */
const AMBIGUOUS_WRITES = new Set(["create", "update", "delete"]);

/**
 * Reads that return VALUES without a `select` to allow-list — `groupBy`
 * hands back the `by:` columns themselves. Banned outright rather than
 * modelled: no portal projection needs one today, and the day one does,
 * the exemption should be a visible change to this file that a reviewer
 * meets, not a shape that was always quietly permitted. (`count` is
 * fine: it returns a number.)
 */
const NOT_ALLOW_LISTABLE = new Set(["groupBy", "aggregate"]);

const RAW = new Set(["$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe"]);

/**
 * KEYS NO PORTAL SELECT MAY NAME, whatever model they sit on — the
 * second tier the security review asked for, and the one that closes
 * the gap between "the select is EXPLICIT" and "the select is SAFE".
 * The AST half proved only the former: `select: { rank: true,
 * triageStatus: true }` is explicit, is a real field, names nothing on
 * the text grep's list, and publishes the agency's internal ordering.
 *
 * It is a SEPARATE list from `PORTAL_FORBIDDEN_COLUMNS` on purpose, and
 * the difference is what each can afford to contain. That one greps the
 * file's TEXT, so it can never hold a common word — `type`, `kind` and
 * `rank` would fire on `type PortalTask = {`, on `readonly kind` and on
 * the paragraph in `portal.ts` that explains why the ordering is NOT by
 * rank. This one fires only on an actual select KEY, so it can hold all
 * three. A name belongs on both lists only when merely mentioning it is
 * already suspicious.
 */
const PORTAL_NEVER_SELECTED: ReadonlySet<string> = new Set([
  // Ordering IS importance (plan §3.1, UI.md rule 5), and importance is
  // on §11's never-shown list.
  "rank",
  "priority",
  // The agency's vocabulary for its own process.
  "type",
  "kind",
  "stateId",
  "triageStatus",
  "snoozedUntil",
  "duplicateOfId",
  // Effort and internal scheduling.
  "estimateMinutes",
  "remainingMinutes",
  "startedAt",
  // Bodies: a 512 KB document and its extracted text, neither of which
  // a list projection has any business carrying.
  "description",
  "descriptionText",
  // Who, internally.
  "assigneeMemberId",
  "createdByMemberId",
  "leadMemberId",
  "actorMemberId",
  "authorMemberId",
  "invitedById",
  // Import provenance and internal notes.
  "sourceSystem",
  "sourceId",
  "importJobId",
  "internalNotes",
  "repoUrl",
  "hostingNotes",
]);

const propName = (p: ts.ObjectLiteralElementLike): string | null => {
  const n = p.name;
  if (!n) return null;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
  return null;
};

const findProp = (obj: ts.ObjectLiteralExpression, key: string): ts.PropertyAssignment | null => {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propName(p) === key) return p;
  }
  return null;
};

/**
 * One file's offences. Every message names the file, the line and what
 * is wrong, because a structural failure that only says "not allow-listed"
 * sends the reader back to the AST.
 */
function auditSource(text: string, label: string, models: ReadonlyMap<string, Model>): string[] {
  const source = ts.createSourceFile(`${label}.ts`, text, ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const at = (node: ts.Node) =>
    `${label}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;

  /** Walk one `select` literal against the model it selects from. */
  const checkSelect = (obj: ts.ObjectLiteralExpression, model: string | null): void => {
    const def = model ? models.get(model) : undefined;
    if (model && !def) {
      out.push(`${at(obj)}: select against unknown model ${model}`);
      return;
    }
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p)) {
        // A spread, a shorthand or a method is exactly how a shared
        // `as const` select gets in, which is the shape AGENTS.md's
        // Prisma trap already forbids for a different reason.
        out.push(`${at(p)}: a select must be an inline literal of explicit keys`);
        continue;
      }
      const key = propName(p);
      if (!key) {
        out.push(`${at(p)}: computed key in a select`);
        continue;
      }
      // SAFE, not merely EXPLICIT (security review, 2026-09-21).
      if (PORTAL_NEVER_SELECTED.has(key)) {
        out.push(`${at(p)}: "${key}" is never selected on the portal plane`);
        continue;
      }
      const value = p.initializer;
      // `_count` is a Prisma pseudo-field that returns a NUMBER, not
      // columns, so it is allowed with a nested literal and not walked
      // as a relation. Named here so the next author meets the rule
      // rather than the AST (code review L6).
      if (key === "_count") {
        if (!ts.isObjectLiteralExpression(value)) {
          out.push(`${at(p)}: _count must carry an inline literal`);
        }
        continue;
      }
      const field = def?.fields.get(key);
      if (def && !field) {
        out.push(`${at(p)}: "${key}" is not a field of ${model}`);
        continue;
      }
      if (field?.relationTo) {
        // THE ONE THIS CHECK EXISTS FOR: `project: true` reads every
        // column of the related row. A relation must carry its own
        // allow-list.
        if (!ts.isObjectLiteralExpression(value)) {
          out.push(`${at(p)}: relation "${key}" must carry its own select, not ${value.getText(source)}`);
          continue;
        }
        const nested = findProp(value, "select");
        if (!nested || !ts.isObjectLiteralExpression(nested.initializer)) {
          out.push(`${at(p)}: relation "${key}" must carry its own inline select`);
          continue;
        }
        for (const sibling of value.properties) {
          const name = ts.isPropertyAssignment(sibling) ? propName(sibling) : null;
          if (name === "include" || name === "omit") {
            out.push(`${at(sibling)}: "${name}" inside a portal select`);
          }
        }
        checkSelect(nested.initializer, field.relationTo);
        continue;
      }
      if (value.kind !== ts.SyntaxKind.TrueKeyword) {
        out.push(`${at(p)}: scalar "${key}" must be selected as \`true\``);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (RAW.has(method)) {
        out.push(`${at(node)}: ${method} — raw SQL has no allow-list a reader can check`);
      }
      const receiver = node.expression.expression;
      const delegate = ts.isPropertyAccessExpression(receiver) ? receiver.name.text : null;
      const model = delegate ? modelOfDelegate(delegate) : null;
      const isModel = model !== null && models.has(model);

      if (NOT_ALLOW_LISTABLE.has(method) && (isModel || delegate === null)) {
        out.push(`${at(node)}: ${method} returns values no select can allow-list`);
      }

      // A Prisma-only method is a row read WHATEVER the receiver looks
      // like. An AMBIGUOUS one counts only when the receiver really is a
      // model delegate, so `Object.create(null)` and `map.delete(x)` are
      // ordinary code rather than offences (code review M3).
      if (PRISMA_ONLY.has(method) || (AMBIGUOUS_WRITES.has(method) && isModel)) {
        // AN UNRESOLVABLE DELEGATE IS AN OFFENCE, not a skip. It used to
        // pass `null` to `checkSelect`, which then had no model to look
        // fields up in — so `relationTo` was undefined, every key read as
        // a scalar, and `tx["workItem"].findMany({ select: { project:
        // true } })` sailed through the one case this check exists for
        // (both reviews, 2026-09-21).
        if (!isModel) {
          out.push(
            `${at(node)}: cannot resolve a Prisma model for this ${method} — write it as tx.<model>.${method}(…) so the select can be checked`,
          );
        }
        const arg = node.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg)) {
          out.push(`${at(node)}: ${method} with no inline argument object`);
        } else {
          for (const key of ["include", "omit"] as const) {
            const found = findProp(arg, key);
            if (found) out.push(`${at(found)}: "${key}" is never allow-listed`);
          }
          const select = findProp(arg, "select");
          if (!select) {
            out.push(`${at(node)}: ${method} without a select — every portal read is an allow-list`);
          } else if (!ts.isObjectLiteralExpression(select.initializer)) {
            out.push(`${at(select)}: select must be an inline object literal`);
          } else {
            checkSelect(select.initializer, isModel ? model : null);
          }
        }
      }
    }
    // A tagged template is how `$queryRaw` is actually written.
    if (ts.isTaggedTemplateExpression(node) && ts.isPropertyAccessExpression(node.tag)) {
      const method = node.tag.name.text;
      if (RAW.has(method)) out.push(`${at(node)}: ${method} — raw SQL has no allow-list a reader can check`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe("every portal read is an explicit allow-list (memo §2.2)", () => {
  const models = parseSchema(readFileSync(SCHEMA, "utf8"));

  it("the schema parse found the models this check reasons about", () => {
    // A silently empty parse would make every assertion below vacuous —
    // the failure mode a structural test is most likely to die of.
    expect(models.size).toBeGreaterThan(40);
    expect(models.get("WorkItem")?.fields.get("title")?.relationTo).toBeNull();
    expect(models.get("WorkItem")?.fields.get("project")?.relationTo).toBe("Project");
    expect(models.get("Contact")?.fields.get("invitedById")?.relationTo).toBeNull();
  });

  it("no portal module reads a row without one", () => {
    const offences = walk(SRC, isPortalSurface).flatMap((file) =>
      auditSource(readFileSync(file, "utf8"), relative(SRC, file), models),
    );
    expect(offences).toEqual([]);
  });

  /**
   * THE CONTROL. A passing structural test is not evidence until it has
   * been made to fail, and these are the ways a projection actually goes
   * wrong. The `project: true` one is the reason the schema is parsed at
   * all: it looks exactly like a scalar pick and returns every column of
   * the related row, never naming a forbidden one.
   */
  it.each([
    ["no select at all", "tx.workItem.findMany({ where: { id } });"],
    ["an include", "tx.workItem.findMany({ include: { project: true }, select: { id: true } });"],
    ["an omit", "tx.workItem.findFirst({ omit: { description: true }, select: { id: true } });"],
    ["a relation picked whole", "tx.workItem.findMany({ select: { id: true, project: true } });"],
    [
      "a relation with no select of its own",
      "tx.workItem.findMany({ select: { project: { where: { id } } } });",
    ],
    ["a nested relation picked whole", "tx.workItem.findMany({ select: { project: { select: { client: true } } } });"],
    ["a field that is not on the model", "tx.workItem.findMany({ select: { secretSauce: true } });"],
    ["a select that is not a literal", "tx.workItem.findMany({ select: SHARED_SELECT });"],
    ["a spread select", "tx.workItem.findMany({ select: { ...BASE, id: true } });"],
    ["a select-less update", "tx.workItem.update({ where: { id }, data: { title } });"],
    ["raw SQL", "tx.$queryRaw`SELECT * FROM work_item`;"],
    // ── added 2026-09-21, one per review finding. Each of these passed
    // the first cut of this check, and the first four are the ones that
    // would have leaked.
    [
      "an element-access delegate hiding a whole relation",
      'tx["workItem"].findMany({ select: { id: true, project: true } });',
    ],
    [
      "a delegate lifted into a local, hiding a whole relation",
      "wi.findMany({ select: { id: true, project: true } });",
    ],
    ["an internal scalar that is explicit but not safe", "tx.workItem.findMany({ select: { rank: true } });"],
    [
      "the agency's own process vocabulary",
      "tx.workItem.findMany({ select: { triageStatus: true, snoozedUntil: true } });",
    ],
    ["the 512 KB body", "tx.workItem.findMany({ select: { description: true } });"],
    ["groupBy, which no select can allow-list", 'tx.workItem.groupBy({ by: ["rank"] });'],
    ["aggregate", "tx.workItem.aggregate({ _max: { rank: true } });"],
  ])("fails on %s", (_name, body) => {
    expect(auditSource(body, "probe", models)).not.toEqual([]);
  });

  /**
   * THE OTHER HALF OF THE CONTROL: ordinary JavaScript in a scanned file
   * must NOT fail. This walk now covers `src/auth/portal.ts` (a Better
   * Auth config, not a projection) and every file that mentions
   * `withPortalRead`, so a check that flagged `Object.create(null)` —
   * which is AGENTS.md's own ProseMirror trap — would break unrelated
   * work with a message about allow-lists.
   */
  it.each([
    ["Object.create", "const attrs = Object.create(null);"],
    ["a Map delete", "CONTACT_TRANSACTIONS.delete(tx);"],
    ["a Headers delete", "headers.delete('cookie');"],
    ["a hash update", "createHash('sha256').update(buf);"],
    ["a non-Prisma create", "const ctx = builder.create({ verbose: true });"],
  ])("passes %s, which is not a Prisma call at all", (_name, body) => {
    expect(auditSource(body, "probe", models)).toEqual([]);
  });

  it("passes the shape a projection is supposed to have", () => {
    expect(
      auditSource(
        "tx.workItem.findMany({ where: { id }, select: { id: true, title: true, project: { select: { name: true } } } });",
        "probe",
        models,
      ),
    ).toEqual([]);
  });

  it("scans more than the two conventional filenames", () => {
    // The widening is itself asserted: a walk that quietly went back to
    // matching `portal.ts` alone would make every case above vacuous for
    // the surfaces that matter most.
    const scanned = walk(SRC, isPortalSurface).map((f) => relative(SRC, f).replaceAll("\\", "/"));
    expect(scanned).toContain("modules/work/portal.ts");
    expect(scanned).toContain("app/(portal)/portal/page.tsx");
    expect(scanned).toContain("portal/authorize.ts");
    // The named surface: a member-plane file that is neither conventionally
    // named nor under (portal) nor a mentioner of `withPortalRead`.
    expect(scanned).toContain("projects/portal-preview.ts");
    // View-as-Contact: a member-plane ROUTE GROUP that renders portal
    // output. Structural tier only — see `VIEW_AS_ROUTES`.
    expect(scanned).toContain("app/(tenant)/view-as/page.tsx");
    // …and the service behind it, which reads the contact row.
    expect(scanned).toContain("clients/view-as.ts");
    // The file that answers that request, and authors the one
    // member-written string a contact reads (slice 6b).
    expect(scanned).toContain("modules/work/triage.ts");
    // The file that performs the contact-caused INSERT. Structural tier
    // only, like view-as, and for the same reason — see
    // `STRUCTURAL_ONLY_SURFACES`. Without this line the widening could
    // be undone and every case above would go on passing.
    expect(scanned).toContain("modules/work/requests.ts");
    // …and the brokered writer itself, which is in BOTH tiers.
    expect(scanned).toContain("modules/work/portal-writes.ts");
    // …and never a test, which is where the hazards are named on purpose.
    expect(scanned.filter((f) => f.includes(".dbtest.") || f.includes(".test."))).toEqual([]);
  });
});
