import { resolveScope } from "@/authz/authorize";
import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";

import {
  MAX_QUERY_CHARS,
  PER_TYPE_LIMIT,
  SEARCH_ENTITY_TYPES,
  TOTAL_LIMIT,
  isSearchEntityType,
  type SearchEntityType,
} from "./shape";

/**
 * Reading `search_index` (DATA_MODEL.md §6.19).
 *
 * The table, its RLS, its generated tsvector and its six feed triggers
 * all shipped with 2W core. This is the first thing that reads it, and
 * every rule below is one the reconnaissance found the hard way rather
 * than a preference.
 *
 * IT IS RAW SQL, AND IT MUST BE. `search_index` is deliberately not a
 * Prisma model (prisma/schema.prisma records the counter-decision), and
 * it could not usefully be one: the driver adapter has no mapping for
 * `tsvector` (OID 3614) or `regconfig` (3734), both below
 * `FIRST_NORMAL_OBJECT_ID`, so they raise `UnsupportedNativeDataType`.
 * `SELECT *` from this table is a RUNTIME ERROR. Every read therefore
 * names its columns, and neither of those two is ever among them.
 *
 * MEMBER SCOPE IS APPLIED BY HAND, and that is the sharp edge. RLS on
 * this table carries tenant isolation and the contact portal gate and
 * NOTHING ELSE — there is no `member_client` term in either policy — so
 * a bare tenant-scoped read returns every project's rows in the tenant,
 * and the index row already holds `title`, `subtitle`, `state_category`
 * and `assignee_member_id`: everything a result row renders. `scopeWhere`
 * cannot help here (it returns a Prisma `where` keyed on camelCase model
 * fields), so the scope is composed into the SQL below from
 * `resolveScope`, and AUTHZ.md §4 now says plainly that only a dbtest
 * guards that — there is no lint rule, whatever it used to claim.
 *
 * THE LANGUAGE COMES FROM THE ROW, never from a literal. `lang` is a
 * per-row `regconfig` stamped at feed time from the tenant's locale, so
 * the query is `search @@ websearch_to_tsquery(lang, $q)`. The one
 * existing query in the repo — the lexeme probe in `work.dbtest.ts` —
 * hardcodes `'public.fortleva_sv'`, and copying it would silently
 * return nothing for every `en` tenant.
 *
 * SCOPE IS NOT A PERMISSION, AND SEARCH NEEDS BOTH. Assignments and
 * roles are independent axes (AUTHZ.md §4, "Permission ∧ scope"): a
 * member seated on a custom role holding nothing but `invoice:view`,
 * with one `MemberClient`, can open no board, no client and no document
 * — and an unguarded search would still have handed them every work
 * item title, every document name, every client and contact name, and
 * the first 140 characters of every internal COMMENT on that client,
 * because a COMMENT row's `title` IS `left(body_text, 140)`. So each
 * entity type is gated by the permission that governs reading it, and
 * the gate is `requireAccess`, which is also the flag, entitlement and
 * tenant-preference check: a tenant that switched a module OFF keeps
 * being fed by the triggers, and must not be searchable through the
 * back door its list pages close.
 *
 * The gate is an `entity_type = ANY(...)` TERM IN THE SQL, never a
 * filter over the rows afterwards: a post-filter lets forbidden rows
 * occupy the per-type cap and the total limit, so a permitted row could
 * be pushed out of the answer by one the member may not see.
 */

export type SearchCtx = { readonly tenantId: string; readonly actor: MemberActor };

export {
  SEARCH_ENTITY_TYPES,
  isSearchEntityType,
  PER_TYPE_LIMIT,
  TOTAL_LIMIT,
  MAX_QUERY_CHARS,
  type SearchEntityType,
} from "./shape";

/**
 * The permission that governs READING each type — and therefore, through
 * `requireAccess`, the module flag, the entitlement and the tenant
 * preference behind it too. Search is a lens over what a member may
 * already open; it must never be a way round the page that opens it.
 *
 * A COMMENT is read under `work_item:view` because a comment's index
 * row is a work item's conversation, and there is no `comment:view`
 * code — the two `comment:*` codes are edit_any and delete.
 */
const PERMISSION_BY_TYPE: Record<SearchEntityType, string> = {
  WORK_ITEM: "work_item:view",
  COMMENT: "work_item:view",
  DOCUMENT: "document:view",
  PROJECT: "project:view",
  CLIENT: "client:view",
  CONTACT: "client:view",
};

export type SearchHit = {
  readonly entityType: SearchEntityType;
  readonly entityId: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly projectId: string | null;
  readonly clientId: string | null;
  readonly stateCategory: string | null;
  readonly updatedAt: Date;
  /** `ts_rank_cd`, exposed so a caller can merge types without re-ranking. */
  readonly rank: number;
  /**
   * Where the row goes, resolved in the hydrate step from the LIVE source
   * rather than from the index. A work item's address needs its project
   * KEY and its number, and the index carries neither as a field — only
   * as the display string in `subtitle`. Parsing an address back out of
   * a label is how a rename silently breaks every link, so the hydrate
   * that already re-reads the source for freshness returns the address
   * too.
   */
  readonly href: string;
};

/** A row as the index holds it — before the hydrate resolves its
 * address and confirms its source is still live. */
type RawHit = Omit<SearchHit, "href">;

/** A work item as the hydrate reads it: liveness, address and whether
 * the backlog will need asking for archived rows. */
type LiveItem = {
  id: string;
  number: number;
  archivedAt: Date | null;
  projectId: string;
  project: { key: string };
};

type Row = {
  entity_type: string;
  entity_id: string;
  title: string;
  subtitle: string | null;
  project_id: string | null;
  client_id: string | null;
  state_category: string | null;
  updated_at: Date;
  rank: number;
};

/**
 * A query is usable when `websearch_to_tsquery` would produce at least
 * one lexeme. Checked in the DATABASE rather than guessed at, because
 * stop words are the configuration's business: "the" and "och" parse to
 * an empty tsquery, which matches nothing, and telling the member "no
 * results" for that is worse than telling them the query was too vague.
 */
export type SearchOutcome =
  | { readonly kind: "results"; readonly hits: readonly SearchHit[] }
  | { readonly kind: "empty-query" };

export async function search(ctx: SearchCtx, raw: string): Promise<SearchOutcome> {
  // Control characters are stripped before anything else: a NUL byte
  // reaches the driver as an untyped error rather than an outcome this
  // function can describe, and no control character can be part of a
  // word anyone is searching for.
  const q = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_QUERY_CHARS);
  if (q.length === 0) return { kind: "empty-query" };

  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    // ASKED SEPARATELY, and it has to be. A stop-words-only query parses
    // to zero lexemes and therefore matches nothing — which is
    // indistinguishable, in the result set, from a good query that found
    // nothing. Folding the check into the main WHERE would collapse the
    // two into "no results" and tell a member searching "the" that their
    // workspace holds nothing about it.
    // ASKED OVER THE CONFIGS THIS TENANT ACTUALLY HOLDS, and no others.
    // Rows are restamped when the locale changes (search/rebuild.ts),
    // but a row fed by a transaction that read the old locale and
    // committed after the restamp keeps the old config, and so does any
    // row written by a path that bypasses the settings write. The match
    // below uses each ROW's `lang` for the same reason; a probe that
    // asked only today's config would call a term a stop word and
    // report "empty query" for exactly the rows still findable through
    // the other one.
    //
    // A review proposed asking both configs directly instead, on the
    // grounds that the set is closed (`fortleva_sv` | `fortleva_en`) and
    // the scan could be saved. IT IS NOT EQUIVALENT, and a dbtest caught
    // it: "och" is a Swedish stop word and an ordinary English word, so
    // `GREATEST(sv, en)` reports it as meaningful and a Swedish tenant
    // searching "och" is told "nothing matched" instead of "that needs a
    // word to go on". The whole point of this probe is that distinction.
    //
    // The DISTINCT scan is therefore the price of the answer being
    // right. `search_lang` is the fallback for a tenant with no rows
    // yet, where there is no config to sample.
    const parsed = await tx.$queryRaw<{ lexemes: number }[]>`
      SELECT GREATEST(
               COALESCE((SELECT MAX(numnode(websearch_to_tsquery(l.lang, ${q})))
                           FROM (SELECT DISTINCT lang FROM search_index
                                  WHERE tenant_id = ${ctx.tenantId}) l), 0),
               CASE WHEN EXISTS (SELECT 1 FROM search_index WHERE tenant_id = ${ctx.tenantId})
                    THEN 0
                    ELSE numnode(websearch_to_tsquery(search_lang(${ctx.tenantId}), ${q}))
               END
             )::int AS lexemes`;
    if ((parsed[0]?.lexemes ?? 0) === 0) return { kind: "empty-query" } as const;

    const allowed = await allowedTypes(tx, ctx);
    if (allowed.length === 0) return { kind: "results", hits: [] } as const;
    return { kind: "results", hits: await runSearch(tx, ctx, q, allowed) } as const;
  });
}

/**
 * The types this member may read, resolved through the same gate every
 * list page uses. `requireAccess` throws, so each type is asked
 * individually and a refusal removes the type rather than the answer —
 * a member who may see tasks but not documents gets tasks.
 *
 * Six types collapse to four distinct codes, and the codes are asked
 * once each: `requireAccess` re-reads the flag, the entitlement and the
 * preference per call, so asking per TYPE would pay for `work_item:view`
 * and `client:view` twice for nothing.
 */
async function allowedTypes(tx: TenantDb, ctx: SearchCtx): Promise<SearchEntityType[]> {
  const codes = [...new Set(Object.values(PERMISSION_BY_TYPE))];
  const verdicts = await Promise.all(
    codes.map(async (code) => {
      try {
        await requireAccess(tx, ctx.tenantId, ctx.actor, code);
        return [code, true] as const;
      } catch (e) {
        // Only an authorization refusal narrows the answer. Anything
        // else — a dead connection, a bad code — must surface, or a
        // broken gate would look like an empty workspace.
        if (e instanceof AuthzError) return [code, false] as const;
        throw e;
      }
    }),
  );
  const held = new Map(verdicts);
  return SEARCH_ENTITY_TYPES.filter((t) => held.get(PERMISSION_BY_TYPE[t]) === true);
}

async function runSearch(
  tx: TenantDb,
  ctx: SearchCtx,
  q: string,
  allowed: readonly SearchEntityType[],
): Promise<SearchHit[]> {
  const scope = await resolveScope(tx, ctx.actor);

  // Deny-default: a member with no assignments and no `client:view_all`
  // matches nothing, and says so without a query. Without this the
  // `IN ()` below would have to be spelled as an always-false term.
  if (!scope.all && scope.directClientIds.length === 0 && scope.projectIds.length === 0) {
    return [];
  }

  // `$queryRaw` with tagged-template parameters throughout — never
  // string interpolation. The id lists go in as ARRAYS compared with
  // `= ANY($n::text[])`, one parameter each rather than an expanded
  // IN-list, so a member on 300 projects does not build a
  // 300-parameter statement. The explicit cast is what lets an EMPTY
  // array be passed safely, which is why there is no sentinel value in
  // here: `client_id = ANY(ARRAY[''])` would match a row whose id were
  // literally the empty string, and a filter should not carry a value
  // that can match anything at all.
  const clientIds = scope.all ? [] : scope.directClientIds;
  const projectIds = scope.all ? [] : scope.projectIds;
  // LIFTED ids are for the CLIENT and CONTACT rows ONLY, and that
  // narrowness is the whole point. A member on project P1 of Acme may
  // open Acme's card — name and contacts — but must not see Acme's
  // OTHER projects (AUTHZ.md §4: "the lifted client ids are
  // deliberately absent, which is precisely what keeps P2 invisible to
  // a P1-only member"). Putting them in the general client term would
  // be the actual security bug; leaving them out entirely made search
  // disagree with `/clients`, where the same member can see that card.
  const liftedIds = scope.all ? [] : scope.liftedClientIds;
  const unscoped = scope.all;
  const types = [...allowed];

  // THE CONFIG COMES FROM THE ROW (`si.lang`), not from a literal and
  // not from one sampled row. A locale change restamps the tenant's rows
  // in the same transaction (search/rebuild.ts), so they normally all
  // agree — but a row fed concurrently with that change, or by a path
  // that bypassed it, keeps the config it was stemmed in, and matching
  // per row keeps it findable in that language rather than in none.
  //
  // The tsquery is built ONCE per row in a LATERAL rather than three
  // times inline (WHERE, rank, and the window's ORDER BY): each build
  // is a parse plus the unaccent and stemmer dictionaries, and without
  // a GIN index this runs over every row of the tenant.
  const rows = await tx.$queryRaw<Row[]>`
    WITH matched AS (
      SELECT si.entity_type,
             si.entity_id,
             si.title,
             si.subtitle,
             si.project_id,
             si.client_id,
             si.state_category AS state_category,
             si.updated_at,
             ts_rank_cd(si.search, t.tsq) AS rank,
             row_number() OVER (
               PARTITION BY si.entity_type
               ORDER BY ts_rank_cd(si.search, t.tsq) DESC, si.updated_at DESC
             ) AS per_type
        FROM search_index si
        CROSS JOIN LATERAL (SELECT websearch_to_tsquery(si.lang, ${q}) AS tsq) t
       WHERE si.tenant_id = ${ctx.tenantId}
         -- The permission gate, as a TERM: a forbidden row must not
         -- occupy a cap slot that a permitted one would have taken.
         AND si.entity_type = ANY(${types}::text[])
         AND si.search @@ t.tsq
         AND (
           ${unscoped}
           OR si.client_id = ANY(${clientIds}::text[])
           OR si.project_id = ANY(${projectIds}::text[])
           -- The client CARD, and only it, through the lifted ids.
           OR (si.entity_type IN ('CLIENT', 'CONTACT')
               AND si.client_id = ANY(${liftedIds}::text[]))
           -- Tenant-wide rows belong to no client and no project, so no
           -- scope term can reach them. They are visible to every member
           -- who holds the type's permission, which is what
           -- listDocuments already does for a tenant-internal file
           -- ("zero assignments => only tenant-internal"). Without this,
           -- search disagreed with the page it is a lens over.
           OR (si.client_id IS NULL AND si.project_id IS NULL)
         )
    )
    SELECT entity_type, entity_id, title, subtitle, project_id, client_id,
           state_category, updated_at, rank
      FROM matched
     WHERE per_type <= ${PER_TYPE_LIMIT}
     ORDER BY rank DESC, updated_at DESC
     LIMIT ${TOTAL_LIMIT}`;

  // The allow-list already ran in SQL; this is the TYPE narrower, not
  // the gate. A row that survived the WHERE and fails here would be a
  // type the database knows and this build does not.
  const hits = rows.filter((r) => isSearchEntityType(r.entity_type)).map(toHit);
  return hydrate(tx, ctx, hits);
}

/**
 * THE SECOND BELT (§6.19: "hydrated by id under the caller's principal,
 * so a stale index row cannot leak a since-hidden fact").
 *
 * `search_index` is fed by AFTER triggers, so it is normally exact — but
 * "normally" is not a safety property, and this product has already shipped
 * one trigger that missed a soft delete for three weeks. The index has no
 * foreign keys either, so nothing removes a row whose source vanishes by a
 * path the feed does not see.
 *
 * The gap it was written for — a COMMENT outliving the task it was
 * written on, with an index row whose title IS the first 140 characters
 * of its body — is closed at the source since 2026-09-07: `deleteItem`
 * and the document delete both cascade to comments
 * (`comments/cascade.ts`). The belt stays for rows that predate the
 * cascade and for hand-run maintenance paths, which is what a belt is
 * for.
 *
 * Batched per type, never per row, and only for the types that can go
 * stale: PROJECT, CLIENT and CONTACT have no soft delete. A hit whose
 * source no longer resolves is DROPPED rather than repaired — repairing
 * the index from a read path would make a search a write.
 */
async function hydrate(
  tx: TenantDb,
  ctx: SearchCtx,
  hits: readonly RawHit[],
): Promise<SearchHit[]> {
  const idsOf = (t: SearchEntityType) =>
    hits.filter((h) => h.entityType === t).map((h) => h.entityId);
  const itemIds = idsOf("WORK_ITEM");
  const commentIds = idsOf("COMMENT");
  const documentIds = idsOf("DOCUMENT");
  // No early return: this pass resolves ADDRESSES as well as liveness,
  // and PROJECT / CLIENT / CONTACT hits need one even though none of
  // them can go stale. The three reads below are each guarded by their
  // own length, so a result set of only those types still costs nothing.

  const [liveItems, liveComments, liveDocuments] = await Promise.all([
    itemIds.length
      ? tx.workItem.findMany({
          where: { tenantId: ctx.tenantId, id: { in: itemIds }, deletedAt: null },
          // number + key: the ADDRESS, read from the live row. The index
          // has neither as a field — only baked into `subtitle` as
          // "KEY-12" — and parsing an address back out of a label is how
          // a project rename silently breaks every link.
          select: {
            id: true,
            number: true,
            // archived rows STAY in the index by design, and the backlog
            // hides them unless asked — so the address has to ask.
            archivedAt: true,
            projectId: true,
            project: { select: { key: true } },
          },
        })
      : [],
    commentIds.length
      ? tx.comment.findMany({
          where: { tenantId: ctx.tenantId, id: { in: commentIds }, deletedAt: null },
          select: { id: true, subjectType: true, subjectId: true },
        })
      : [],
    documentIds.length
      ? tx.document.findMany({
          where: { tenantId: ctx.tenantId, id: { in: documentIds }, deletedAt: null },
          select: { id: true },
        })
      : [],
  ]);

  const itemById = new Map<string, LiveItem>(liveItems.map((i) => [i.id, i]));

  // A comment survives only if ITS SUBJECT does — the cascade takes the
  // ordinary case at delete time, and this catches whatever it did not.
  //
  // The parent is selected in FULL, not just its id, because a comment's
  // ADDRESS is its parent's address — and building `itemById` from the
  // work-item HITS alone meant every comment whose task did not also
  // match the same query resolved to no address and was dropped. That
  // made comments unsearchable while the UI kept promising them.
  const parentIds = liveComments
    .filter((c) => c.subjectType === "WORK_ITEM")
    .map((c) => c.subjectId)
    .filter((id) => !itemById.has(id));
  const parentRows = parentIds.length
    ? await tx.workItem.findMany({
        where: { tenantId: ctx.tenantId, id: { in: parentIds }, deletedAt: null },
        select: {
          id: true,
          number: true,
          archivedAt: true,
          projectId: true,
          project: { select: { key: true } },
        },
      })
    : [];
  for (const row of parentRows) itemById.set(row.id, row);
  const liveParents = new Set([
    ...parentRows.map((i) => i.id),
    ...[...itemById.keys()],
  ]);

  const live: Record<SearchEntityType, Set<string> | null> = {
    WORK_ITEM: new Set(liveItems.map((i) => i.id)),
    // Liveness is checked for WORK_ITEM parents only. Comments on other
    // subjects (DOCUMENT, FILE_VERSION) have no address yet, so they are
    // dropped HERE, deliberately — not left to fall out of addressOf.
    // Whoever gives them an address adds the document liveness read
    // beside this one, or the belt for them is gone.
    //
    // KNOWN COST, unreachable today: `search_index` carries no subject
    // type, so the SQL cannot exclude these rows and they still take
    // slots under the per-type cap — enough of them would push an
    // openable task comment out of an answer that then shows nothing.
    // No comment can be written outside a dbtest yet; the comment
    // service is where this has to be settled, by addressing document
    // comments rather than by widening the cap.
    COMMENT: new Set(
      liveComments
        .filter((c) => c.subjectType === "WORK_ITEM" && liveParents.has(c.subjectId))
        .map((c) => c.id),
    ),
    DOCUMENT: new Set(liveDocuments.map((d) => d.id)),
    // No soft delete on these three: the index row is the only record of
    // them that could be stale, and a hard delete fires the feed.
    PROJECT: null,
    CLIENT: null,
    CONTACT: null,
  };
  const survivors = hits.filter((h) => {
    const set = live[h.entityType];
    return set === null || set.has(h.entityId);
  });

  // Project keys for every address that needs one, in one read.
  // ONLY the two types whose address consults it: WORK_ITEM and COMMENT
  // take the key off `itemById`, which already joined it. Adding every
  // hit's projectId read the whole project list for nothing on a
  // task-heavy answer.
  const keyNeeded = new Set<string>();
  for (const h of survivors) {
    if (h.entityType === "PROJECT") keyNeeded.add(h.entityId);
    else if (h.entityType === "DOCUMENT" && h.projectId) keyNeeded.add(h.projectId);
  }
  const keyOf = new Map(
    keyNeeded.size
      ? (
          await tx.project.findMany({
            where: { tenantId: ctx.tenantId, id: { in: [...keyNeeded] } },
            select: { id: true, key: true },
          })
        ).map((p) => [p.id, p.key])
      : [],
  );
  const commentSubject = new Map(liveComments.map((c) => [c.id, c]));

  // An address that cannot be resolved DROPS the hit. A result you
  // cannot open is worse than one you never saw — it reads as the
  // product losing your work.
  return survivors.flatMap((h) => {
    const href = addressOf(h, itemById, commentSubject, keyOf);
    return href === null ? [] : [{ ...h, href }];
  });
}

/** Where a hit goes. Every branch is a same-origin absolute path built
 * from ids and keys, never from user text, so no result row can become
 * an off-site link. */
function addressOf(
  h: RawHit,
  itemById: Map<string, LiveItem>,
  commentSubject: Map<string, { subjectType: string; subjectId: string }>,
  keyOf: Map<string, string>,
): string | null {
  const itemHref = (itemId: string): string | null => {
    const item = itemById.get(itemId);
    if (!item) return null;
    const key = item.project.key;
    // `archived=1` when the item is archived: archived rows STAY in the
    // index deliberately (the work_item feed says so), but the backlog
    // resolves `?item=` against the list it loaded, and that list drops
    // archived rows unless asked. Without this the row opens a backlog
    // with no peek and no explanation — which is the "result you cannot
    // open" this whole function exists to avoid.
    const archived = item.archivedAt ? "&archived=1" : "";
    return `/projects/${key}/backlog?item=${key}-${item.number}${archived}`;
  };

  switch (h.entityType) {
    case "WORK_ITEM":
      return itemHref(h.entityId);
    case "COMMENT": {
      // A comment is found through the thing it is written on.
      const subject = commentSubject.get(h.entityId);
      if (subject?.subjectType === "WORK_ITEM") return itemHref(subject.subjectId);
      return null;
    }
    case "PROJECT": {
      const key = keyOf.get(h.entityId);
      return key ? `/projects/${key}` : null;
    }
    case "DOCUMENT": {
      const key = h.projectId ? keyOf.get(h.projectId) : null;
      if (key) return `/projects/${key}/files`;
      return h.clientId ? `/clients/${h.clientId}/files` : "/files";
    }
    case "CLIENT":
      return `/clients/${h.entityId}`;
    case "CONTACT":
      return h.clientId ? `/clients/${h.clientId}/contacts` : null;
  }
}

const toHit = (r: Row): RawHit => ({
  entityType: r.entity_type as SearchEntityType,
  entityId: r.entity_id,
  title: r.title,
  subtitle: r.subtitle,
  projectId: r.project_id,
  clientId: r.client_id,
  stateCategory: r.state_category,
  updatedAt: r.updated_at,
  // `ts_rank_cd` returns float4; the driver gives a JS number.
  rank: Number(r.rank),
});
