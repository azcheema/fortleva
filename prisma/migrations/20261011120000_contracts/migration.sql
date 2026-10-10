-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 112 — CONTRACTS: TEMPLATES AND DRAFTS (founder decision
-- C84 (a), (e), (g)). DATA_MODEL.md §6.6 (as built); the design and its
-- review: docs/research/2026-10-10-slice-112-contracts-design.md (§10
-- overrides the body).
--
-- Two tables. Nothing here reaches a client: no contract can leave DRAFT in
-- this slice (the guard refuses every status move until slice 112b replaces
-- it), and the portal gate never shows a draft.
--
-- 1. `contract_template` — CLASS A. The company's standard wording with
--    `{{key}}` fill-ins (src/modules/contracts/fill-ins.ts), kept by owners
--    and admins: every write by a member AS THEMSELVES holding
--    `contract:manage_templates` (C84 (g)). A contract copies the body when it
--    is started, so a template is changed or deleted freely. Names unique per
--    workspace, case-insensitively.
--
-- 2. `contract` — CLASS B, status-structural (`PORTAL_GATE_VARIANTS.contract`,
--    the `invoice` precedent): a contact reads a contract of their own client
--    only once it is NOT a draft AND (written and sent, or signed elsewhere and
--    shown to them — slice 112c), and only while they are a MAIN contact
--    (`portal_contract_primary`, AUTHZ §8: contracts are CONTACT_PRIMARY's).
--    A contact writes none (the census's named denies). In this slice:
--      INSERT   a WRITTEN DRAFT, version 1, made now, by a member as
--               themselves holding `contract:create`;
--      UPDATE   a DRAFT's title, body, language, signer and dates only, by a
--               holder of `contract:edit`; every other column frozen, and NO
--               status move (112b);
--      DELETE   a DRAFT only, by a holder of `contract:delete`.
--    The signer is a DRAFT's choice with NO foreign key (design §10 item 2):
--    the guard checks it names a contact of the SAME client whenever it is
--    set; a deleted contact leaves a draft naming nobody, and 112b's send
--    re-checks that the contact exists, is ACTIVE and a main contact. The
--    CHECKs that describe a sent, signed or withdrawn contract are written now
--    so the shape is born whole; a DRAFT carries none of those columns.
--
-- MAINTENANCE: platform maintenance (`app.contract_maintenance` on
-- `app_platform` — the `invoice_maintenance` shape) may delete any row, for a
-- tenant's teardown (e2e `removeTenant`, the dbtest fixture).
--
-- The guards' permission join is `invoice_member_holds` (slice 108's generic
-- `effectivePermissions` join, SECURITY INVOKER — reused as is).
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed. Two new empty tables:
-- their CHECKs hold vacuously.
-- ═══════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "contract_origin" AS ENUM ('WRITTEN', 'UPLOADED');

-- CreateEnum
CREATE TYPE "contract_status" AS ENUM ('DRAFT', 'SENT', 'SIGNED', 'DECLINED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "contract_template" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" JSONB,
    "created_by_member_id" TEXT NOT NULL,
    "updated_by_member_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contract_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "origin" "contract_origin" NOT NULL DEFAULT 'WRITTEN',
    "status" "contract_status" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedes_id" TEXT,
    "template_id" TEXT,
    "body" JSONB,
    "language" VARCHAR(2) NOT NULL,
    "signer_contact_id" TEXT,
    "starts_on" DATE,
    "ends_on" DATE,
    "parties" JSONB,
    "content_sha256" CHAR(64),
    "sent_at" TIMESTAMPTZ(6),
    "sent_by_member_id" TEXT,
    "signed_on" DATE,
    "withdrawn_at" TIMESTAMPTZ(6),
    "withdrawn_by_member_id" TEXT,
    "pdf_file_id" TEXT,
    "signed_pdf_file_id" TEXT,
    "shown_to_client" BOOLEAN NOT NULL DEFAULT false,
    "created_by_member_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contract_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contract_template_tenant_id_id_key" ON "contract_template"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "contract_tenant_id_client_id_status_idx" ON "contract"("tenant_id", "client_id", "status");

-- CreateIndex
CREATE INDEX "contract_tenant_id_status_updated_at_idx" ON "contract"("tenant_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "contract_tenant_id_ends_on_idx" ON "contract"("tenant_id", "ends_on");

-- CreateIndex
CREATE UNIQUE INDEX "contract_tenant_id_id_key" ON "contract"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_tenant_id_client_id_id_key" ON "contract"("tenant_id", "client_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_tenant_id_client_id_supersedes_id_key" ON "contract"("tenant_id", "client_id", "supersedes_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_tenant_id_pdf_file_id_key" ON "contract"("tenant_id", "pdf_file_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_tenant_id_signed_pdf_file_id_key" ON "contract"("tenant_id", "signed_pdf_file_id");

-- AddForeignKey
ALTER TABLE "contract_template" ADD CONSTRAINT "contract_template_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract" ADD CONSTRAINT "contract_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract" ADD CONSTRAINT "contract_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract" ADD CONSTRAINT "contract_tenant_id_client_id_supersedes_id_fkey" FOREIGN KEY ("tenant_id", "client_id", "supersedes_id") REFERENCES "contract"("tenant_id", "client_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contract" ADD CONSTRAINT "contract_tenant_id_pdf_file_id_fkey" FOREIGN KEY ("tenant_id", "pdf_file_id") REFERENCES "file_object"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract" ADD CONSTRAINT "contract_tenant_id_signed_pdf_file_id_fkey" FOREIGN KEY ("tenant_id", "signed_pdf_file_id") REFERENCES "file_object"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── 1. contract_template: its shape ─────────────────────────────────
-- A name a person can read and tell apart, stored trimmed; the body the
-- normaliser's cap (`normalizeContractBody`: 512 KB of COMPACT JSON) with real
-- headroom — `jsonb::text` adds a space after every `:` and `,`, some 14% on a
-- body of one-letter runs (the pre-apply review's low), so 1 MiB here.
ALTER TABLE contract_template
  ADD CONSTRAINT contract_template_name_shape CHECK (char_length(name) BETWEEN 1 AND 120 AND name = btrim(name) AND name <> ''),
  ADD CONSTRAINT contract_template_body CHECK (body IS NULL OR (jsonb_typeof(body) = 'object' AND octet_length(body::text) <= 1048576));

-- One name per workspace, whatever its case (the `label` precedent).
CREATE UNIQUE INDEX contract_template_name_key ON contract_template (tenant_id, lower(name));


-- ── 2. contract: its shape ──────────────────────────────────────────
ALTER TABLE contract
  ADD CONSTRAINT contract_title CHECK (char_length(title) BETWEEN 1 AND 200 AND title = btrim(title) AND title <> ''),
  ADD CONSTRAINT contract_language CHECK (language IN ('sv', 'en')),
  -- Version 1 replaces nothing; a later version replaces exactly one.
  ADD CONSTRAINT contract_version CHECK (version >= 1 AND (version = 1) = (supersedes_id IS NULL)),
  ADD CONSTRAINT contract_body CHECK (
        (origin = 'WRITTEN' OR body IS NULL)
    AND (body IS NULL OR (jsonb_typeof(body) = 'object' AND octet_length(body::text) <= 1048576))),
  ADD CONSTRAINT contract_dates CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on),
  -- A DRAFT is written in Fortleva and carries NOTHING of a sent contract
  -- (the design review's item 12 — the `invoice_issued_record` precedent).
  ADD CONSTRAINT contract_draft_bare CHECK (
    status <> 'DRAFT' OR (
          origin = 'WRITTEN'
      AND num_nonnulls(parties, content_sha256, sent_at, sent_by_member_id, signed_on,
                       withdrawn_at, withdrawn_by_member_id, pdf_file_id, signed_pdf_file_id) = 0
      AND NOT shown_to_client)),
  -- A written contract past DRAFT was SENT: by whom, when, to whom, the
  -- parties as printed, and the fingerprint both signatures attest to (112b).
  ADD CONSTRAINT contract_sent_record CHECK (
    origin <> 'WRITTEN' OR status = 'DRAFT'
    OR num_nonnulls(sent_at, sent_by_member_id, content_sha256, parties, signer_contact_id) = 5),
  ADD CONSTRAINT contract_content_sha256 CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT contract_parties CHECK (parties IS NULL OR jsonb_typeof(parties) = 'object'),
  ADD CONSTRAINT contract_signed_on CHECK (status <> 'SIGNED' OR signed_on IS NOT NULL),
  ADD CONSTRAINT contract_withdrawn CHECK (
    (status = 'WITHDRAWN') = (withdrawn_at IS NOT NULL)
    AND (withdrawn_at IS NULL) = (withdrawn_by_member_id IS NULL)),
  -- Signed elsewhere is only ever SIGNED, with its file (112c stores the file
  -- first), and only it may be shown by a tick; a written one is shown by
  -- being sent.
  ADD CONSTRAINT contract_uploaded CHECK (origin <> 'UPLOADED' OR (status = 'SIGNED' AND signed_pdf_file_id IS NOT NULL)),
  ADD CONSTRAINT contract_shown CHECK (NOT shown_to_client OR origin = 'UPLOADED');


-- ── 3. contract_template_guard ──────────────────────────────────────
CREATE OR REPLACE FUNCTION contract_template_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
  at timestamptz := statement_timestamp();
  slack constant interval := interval '5 minutes';
  maintenance boolean := current_setting('app.contract_maintenance', true) = 'on' AND current_user = 'app_platform';
BEGIN
  IF TG_OP = 'DELETE' AND maintenance THEN
    RETURN OLD;
  END IF;
  IF who = 'contact' THEN
    RAISE EXCEPTION 'CONTRACT_TEMPLATE_GUARD: a contact writes no template';
  END IF;
  IF who IS DISTINCT FROM 'member'
     OR NOT invoice_member_holds(COALESCE(NEW.tenant_id, OLD.tenant_id), who_id, 'contract:manage_templates') THEN
    RAISE EXCEPTION 'CONTRACT_TEMPLATE_GUARD: templates are kept by a member holding contract:manage_templates';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by_member_id IS DISTINCT FROM who_id OR NEW.updated_by_member_id IS DISTINCT FROM who_id THEN
      RAISE EXCEPTION 'CONTRACT_TEMPLATE_GUARD: a member makes a template as themselves';
    END IF;
    IF NEW.created_at < at - slack OR NEW.created_at > at + slack THEN
      RAISE EXCEPTION 'CONTRACT_TEMPLATE_GUARD: a template is made now';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: the name and the body change, by a member as themselves.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_by_member_id IS DISTINCT FROM OLD.created_by_member_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'CONTRACT_TEMPLATE_GUARD: only a template''s name and text change';
  END IF;
  IF NEW.updated_by_member_id IS DISTINCT FROM who_id THEN
    RAISE EXCEPTION 'CONTRACT_TEMPLATE_GUARD: a member changes a template as themselves';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER contract_template_guard
  BEFORE INSERT OR UPDATE OR DELETE ON contract_template
  FOR EACH ROW EXECUTE FUNCTION contract_template_guard();


-- ── 4. contract_guard (slice 112's — 112b replaces it) ─────────────
CREATE OR REPLACE FUNCTION contract_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
  at timestamptz := statement_timestamp();
  slack constant interval := interval '5 minutes';
  maintenance boolean := current_setting('app.contract_maintenance', true) = 'on' AND current_user = 'app_platform';
  -- What a DRAFT may change. Slice 112b widens the guard with the send.
  editable constant text[] := ARRAY['title', 'body', 'language', 'signer_contact_id', 'starts_on', 'ends_on', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF maintenance THEN
      RETURN OLD;
    END IF;
    IF who = 'contact' THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contact deletes no contract';
    END IF;
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'CONTRACT_NOT_DRAFT: only a draft is deleted';
    END IF;
    IF who IS DISTINCT FROM 'member' OR NOT invoice_member_holds(OLD.tenant_id, who_id, 'contract:delete') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a draft is deleted by a member holding contract:delete';
    END IF;
    RETURN OLD;
  END IF;

  -- Class B gives a contact nothing to write (the census's named denies);
  -- the guard says so too.
  IF who = 'contact' THEN
    RAISE EXCEPTION 'CONTRACT_GUARD: a contact writes no contract';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF who IS DISTINCT FROM 'member' OR NEW.created_by_member_id IS DISTINCT FROM who_id THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a member starts a contract, as themselves';
    END IF;
    IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'contract:create') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract is started by a member holding contract:create';
    END IF;
    IF NEW.status <> 'DRAFT' OR NEW.origin <> 'WRITTEN' OR NEW.version <> 1 OR NEW.supersedes_id IS NOT NULL THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a new contract is a written draft, version 1';
    END IF;
    IF NEW.created_at < at - slack OR NEW.created_at > at + slack THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract is started now';
    END IF;
    IF NEW.signer_contact_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM contact c
                        WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.signer_contact_id
                          AND c.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'CONTRACT_SIGNER_INVALID: the signer is a contact of the contract''s client';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE.
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'CONTRACT_NOT_DRAFT: only a draft changes (slice 112)';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'CONTRACT_GUARD: a contract is not sent in this slice';
  END IF;
  IF who IS DISTINCT FROM 'member' OR NOT invoice_member_holds(OLD.tenant_id, who_id, 'contract:edit') THEN
    RAISE EXCEPTION 'CONTRACT_GUARD: a draft is edited by a member holding contract:edit';
  END IF;
  IF (to_jsonb(NEW) - editable) IS DISTINCT FROM (to_jsonb(OLD) - editable) THEN
    RAISE EXCEPTION 'CONTRACT_GUARD: only a draft''s title, text, language, signer and dates change';
  END IF;
  IF NEW.signer_contact_id IS DISTINCT FROM OLD.signer_contact_id
     AND NEW.signer_contact_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM contact c
                      WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.signer_contact_id
                        AND c.client_id = NEW.client_id) THEN
    RAISE EXCEPTION 'CONTRACT_SIGNER_INVALID: the signer is a contact of the contract''s client';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER contract_guard
  BEFORE INSERT OR UPDATE OR DELETE ON contract
  FOR EACH ROW EXECUTE FUNCTION contract_guard();


-- ── 5. Grants ───────────────────────────────────────────────────────
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_template TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON contract TO app_runtime;


-- ── 6. RLS: contract_template — class A (portal_deny) ───────────────
ALTER TABLE contract_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_template FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON contract_template
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON contract_template
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');


-- ── 7. RLS: contract — class B (status-structural) ─────────────────
ALTER TABLE contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON contract
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

-- A contact reads a contract of their own client only once it is NOT a draft
-- and either written and SENT, or signed elsewhere and SHOWN to them (112c);
-- a contact writes none (WITH CHECK — the `invoice` precedent; slice 112b's
-- signature is a row of its own table, not a write to this one).
CREATE POLICY portal_gate ON contract
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND status <> 'DRAFT'
      AND (
        (origin = 'WRITTEN' AND sent_at IS NOT NULL)
        OR (origin = 'UPLOADED' AND shown_to_client)
      )
    )
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
  );

-- The census's three named denies (20260920230000): INSERT and UPDATE through
-- WITH CHECK, DELETE through USING.
CREATE POLICY portal_no_insert ON contract
  AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

CREATE POLICY portal_no_update ON contract
  AS RESTRICTIVE FOR UPDATE TO app_runtime
  WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

CREATE POLICY portal_no_delete ON contract
  AS RESTRICTIVE FOR DELETE TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- Contracts are a MAIN contact's (AUTHZ §8; `portal.contract.view` is
-- CONTACT_PRIMARY's): a contact principal reads none while their own row says
-- otherwise — read under their own RLS, so a demotion bites at once. ANDs with
-- `portal_gate`; it can only narrow, and `isolation.dbtest.ts` pins it by name.
CREATE POLICY portal_contract_primary ON contract
  AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (SELECT EXISTS (
          SELECT 1 FROM contact c
           WHERE c.id = current_setting('app.principal_id', true)
             AND c.portal_profile = 'CONTACT_PRIMARY'))
  );
