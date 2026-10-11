-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 112b — CONTRACTS: SENDING AND SIGNING (founder decisions
-- C84 (b)–(d), C85). DATA_MODEL.md §6.6 (as built); the design and its
-- reviews: docs/research/2026-10-10-slice-112-contracts-design.md (§3.4, and
-- §10's and §11's 112b items, which override the body).
--
-- 1. `contract_guard` REPLACED. Everything slice 112's guard held is held;
--    added:
--      - `updated_at` is the DATABASE'S: `clock_timestamp()` on every UPDATE
--        and INSERT, whatever the app sent (§11 item 8) — the send binds to it.
--      - SEND, DRAFT → SENT, by a member as themselves holding
--        `contract:send`: the body says something and holds no fill-in of the
--        list; the signer is a contact of the client who is ACTIVE in the
--        portal and a MAIN contact (C84 (d)); `sent_at` now. The guard WRITES
--        `parties` (from the tenant and client rows — the app's value is
--        overwritten, §10 item 3) and `content_sha256` (§10 item 10: the
--        sha-256 of a `jsonb_build_object` of the frozen record, hashed HERE,
--        never by the app), and marks the transaction
--        (`app.contract_sent_now` = the contract's id) for the signature
--        rows' guard.
--      - WITHDRAW, SENT → WITHDRAWN, by a holder of `contract:send` as
--        themselves; the pending client row stays PENDING (nothing can move
--        a non-SENT contract any more).
--      - A NEW VERSION: an INSERT that supersedes a DECLINED or WITHDRAWN
--        contract of the same client, version = its version + 1 (one
--        successor each — the unique). "Change it" on a SENT one is a
--        withdrawal and a new version in one transaction.
--      - SENT → SIGNED | DECLINED only from `contract_signature_decided`
--        (below), recognised by its marker AND by `current_user` being that
--        function's owner — never a literal role name (§10 item 7).
--      - The PDFs, set ONCE, NULL → a value, by a member or the system:
--        `pdf_file_id` once sent, `signed_pdf_file_id` once SIGNED; each a
--        CONTRACT_PDF of the tenant.
--
-- 2. `contract_signature` (new, CLASS B). One row per side per contract
--    (C84 (b), (c)): the agency's, SIGNED as the send writes it; the client's,
--    PENDING until the signer decides. Its guard writes the names, emails
--    and fingerprint itself (from `contact`, `"user"` and the contract —
--    never the app's values) and admits an INSERT only during the send that
--    marked the transaction. A contact decides their OWN pending row — a
--    CENSUS WRITE (`portal_signature_decide` WITH CHECK + the column trigger
--    `portal_contact_columns_only` + the transition trigger), still ACTIVE
--    and a MAIN contact at signing (§10 item 6 (d)).
--
-- 3. `contract_signature_evidence` (new, CLASS A). The client signer's IP
--    address and browser — kept as evidence (DATA_MODEL §6.6), never
--    readable by a client (§10 item 11): the contact's update carries them
--    on the signature row, and a SECURITY DEFINER BEFORE trigger moves them
--    here and clears them from the row (a CHECK holds them NULL at rest).
--
-- 4. `contract_signature_decided` — SECURITY DEFINER, AFTER UPDATE of a
--    CLIENT row PENDING → decided: moves the contract SENT → SIGNED (dated in
--    the workspace's time zone) or DECLINED, `WHERE status = 'SENT'`, and
--    RAISES `CONTRACT_NOT_OPEN` when no row moved — so a withdrawal that
--    commits first fails the signature rather than letting it land. Its owner
--    (the migration role) bypasses row security, as `search_lang` and
--    `vault_portal_credentials_on` rely on, so it names the tenant, client
--    and contract itself. Lock order: the signature row, then the contract;
--    the withdraw path locks only the contract — no cycle.
--
-- 5. A DEFERRED constraint trigger: a contract sent in a transaction has,
--    at its commit, exactly one TENANT row SIGNED and one CLIENT row.
--
-- 6. `file_object` (§10 below): a CONTRACT_PDF's row never changes, and is
--    written COMMITTED — the invoice PDF's guard and CHECK, for contracts. The
--    CHECK validates existing rows: none is a CONTRACT_PDF before this slice
--    (checked read-only on dev before applying).
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed. `contract` gains no
-- column. (The pre-apply review's five items are taken: the PDFs tied to
-- their own contract and to a viewer; the decision dated by the database; an
-- empty text refused at sending; this header; a CHECK renamed.)
-- ═══════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "signature_party" AS ENUM ('TENANT', 'CLIENT');

-- CreateEnum
CREATE TYPE "signature_level" AS ENUM ('SES');

-- CreateEnum
CREATE TYPE "signature_status" AS ENUM ('PENDING', 'SIGNED', 'DECLINED');

-- CreateTable
CREATE TABLE "contract_signature" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "party" "signature_party" NOT NULL,
    "signer_member_id" TEXT,
    "signer_contact_id" TEXT,
    "signer_name" TEXT NOT NULL,
    "signer_email" TEXT NOT NULL,
    "level" "signature_level" NOT NULL DEFAULT 'SES',
    "status" "signature_status" NOT NULL DEFAULT 'PENDING',
    "typed_name" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "decline_reason" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "content_sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_signature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_signature_evidence" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "signature_id" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_signature_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contract_signature_tenant_id_client_id_idx" ON "contract_signature"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "contract_signature_tenant_id_signer_contact_id_status_idx" ON "contract_signature"("tenant_id", "signer_contact_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "contract_signature_tenant_id_id_key" ON "contract_signature"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_signature_tenant_id_contract_id_party_key" ON "contract_signature"("tenant_id", "contract_id", "party");

-- CreateIndex
CREATE UNIQUE INDEX "contract_signature_evidence_tenant_id_signature_id_key" ON "contract_signature_evidence"("tenant_id", "signature_id");

-- AddForeignKey
ALTER TABLE "contract_signature" ADD CONSTRAINT "contract_signature_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_signature" ADD CONSTRAINT "contract_signature_tenant_id_client_id_contract_id_fkey" FOREIGN KEY ("tenant_id", "client_id", "contract_id") REFERENCES "contract"("tenant_id", "client_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_signature_evidence" ADD CONSTRAINT "contract_signature_evidence_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_signature_evidence" ADD CONSTRAINT "contract_signature_evidence_tenant_id_signature_id_fkey" FOREIGN KEY ("tenant_id", "signature_id") REFERENCES "contract_signature"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── 1. contract_signature: its shape ────────────────────────────────
ALTER TABLE contract_signature
  -- The one signer column the party names, and only it.
  ADD CONSTRAINT contract_signature_party CHECK (
       (party = 'TENANT' AND signer_member_id IS NOT NULL AND signer_contact_id IS NULL)
    OR (party = 'CLIENT' AND signer_contact_id IS NOT NULL AND signer_member_id IS NULL)),
  -- The agency signs as it sends (C84 (b)): its row is born SIGNED.
  ADD CONSTRAINT contract_signature_tenant_signed CHECK (party = 'CLIENT' OR status = 'SIGNED'),
  ADD CONSTRAINT contract_signature_decided_at CHECK ((status = 'PENDING') = (decided_at IS NULL)),
  ADD CONSTRAINT contract_signature_typed_name CHECK (
       (status = 'SIGNED') = (typed_name IS NOT NULL)
    AND (typed_name IS NULL OR (char_length(typed_name) BETWEEN 1 AND 200 AND typed_name = btrim(typed_name) AND typed_name <> ''))),
  ADD CONSTRAINT contract_signature_decline_reason CHECK (
    decline_reason IS NULL OR (status = 'DECLINED' AND char_length(decline_reason) BETWEEN 1 AND 1000 AND btrim(decline_reason) <> '')),
  -- The evidence never rests on a client-readable row (it is moved to
  -- `contract_signature_evidence` before the row is written).
  ADD CONSTRAINT contract_signature_no_evidence CHECK (ip IS NULL AND user_agent IS NULL),
  ADD CONSTRAINT contract_signature_sha256 CHECK (content_sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE contract_signature_evidence
  ADD CONSTRAINT contract_signature_evidence_lengths CHECK (
    (ip IS NULL OR char_length(ip) <= 100) AND (user_agent IS NULL OR char_length(user_agent) <= 500));


-- ── 2. contract_guard, replaced ─────────────────────────────────────
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
  -- The signature trigger's own move (§4): its marker, AND this function
  -- running as that trigger function's owner — which `app_runtime` never is.
  decided boolean := current_setting('app.contract_decided', true) = COALESCE(NEW.id, OLD.id)
                     AND current_user = (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
                                          WHERE p.oid = 'contract_signature_decided()'::regprocedure);
  -- What a DRAFT may change (slice 112's seven; `updated_at` is now the
  -- guard's own, so it is in no list the app's value could ride on).
  editable constant text[] := ARRAY['title', 'body', 'language', 'signer_contact_id', 'starts_on', 'ends_on', 'updated_at'];
  -- What a send writes.
  sending constant text[] := ARRAY['status', 'sent_at', 'sent_by_member_id', 'parties', 'content_sha256', 'updated_at'];
  -- What a withdrawal writes.
  withdrawing constant text[] := ARRAY['status', 'withdrawn_at', 'withdrawn_by_member_id', 'updated_at'];
  -- What the signature's move writes.
  deciding constant text[] := ARRAY['status', 'signed_on', 'updated_at'];
  pdfs constant text[] := ARRAY['pdf_file_id', 'signed_pdf_file_id', 'updated_at'];
  prev record;
  t record;
  cl record;
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

  -- A contact writes no contract — except through the signature's move.
  IF who = 'contact' AND NOT decided THEN
    RAISE EXCEPTION 'CONTRACT_GUARD: a contact writes no contract';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF who IS DISTINCT FROM 'member' OR NEW.created_by_member_id IS DISTINCT FROM who_id THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a member starts a contract, as themselves';
    END IF;
    IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'contract:create') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract is started by a member holding contract:create';
    END IF;
    IF NEW.status <> 'DRAFT' OR NEW.origin <> 'WRITTEN' THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a new contract is a written draft';
    END IF;
    IF NEW.supersedes_id IS NULL THEN
      IF NEW.version <> 1 THEN
        RAISE EXCEPTION 'CONTRACT_GUARD: a first contract is version 1';
      END IF;
    ELSE
      -- A NEW VERSION of a declined or withdrawn contract of the same client.
      SELECT c.status, c.version INTO prev FROM contract c
       WHERE c.tenant_id = NEW.tenant_id AND c.client_id = NEW.client_id AND c.id = NEW.supersedes_id;
      IF NOT FOUND OR prev.status NOT IN ('DECLINED', 'WITHDRAWN') THEN
        RAISE EXCEPTION 'CONTRACT_NOT_REPLACEABLE: only a declined or withdrawn contract gets a new version';
      END IF;
      IF NEW.version <> prev.version + 1 THEN
        RAISE EXCEPTION 'CONTRACT_GUARD: a new version is the next number';
      END IF;
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
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  -- UPDATE. The database's own clock, whatever the app sent.
  NEW.updated_at := clock_timestamp();

  -- The signature's move: SENT → SIGNED | DECLINED, nothing else.
  IF decided THEN
    IF OLD.status <> 'SENT' OR NEW.status NOT IN ('SIGNED', 'DECLINED')
       OR (to_jsonb(NEW) - deciding) IS DISTINCT FROM (to_jsonb(OLD) - deciding)
       OR (NEW.status = 'DECLINED' AND NEW.signed_on IS NOT NULL) THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a signature moves a sent contract to signed or declined only';
    END IF;
    RETURN NEW;
  END IF;

  IF who IS DISTINCT FROM 'member' AND who IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'CONTRACT_GUARD: a member or the system writes a contract';
  END IF;

  -- The PDFs, set once: no status move, nothing else changed.
  IF NEW.status = OLD.status
     AND (NEW.pdf_file_id IS DISTINCT FROM OLD.pdf_file_id OR NEW.signed_pdf_file_id IS DISTINCT FROM OLD.signed_pdf_file_id) THEN
    IF (to_jsonb(NEW) - pdfs) IS DISTINCT FROM (to_jsonb(OLD) - pdfs) THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a PDF is set on its own';
    END IF;
    IF who = 'member' AND NOT invoice_member_holds(OLD.tenant_id, who_id, 'contract:view') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a PDF is made by a member who may view the contract';
    END IF;
    -- One file is one contract's, in one column: never another contract's PDF
    -- pointed at (that would show one client another's contract — the
    -- pre-apply review's low), nor the same file as both.
    IF NEW.pdf_file_id IS NOT NULL AND NEW.pdf_file_id IS NOT DISTINCT FROM NEW.signed_pdf_file_id THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: the PDF as sent and the signed copy are two files';
    END IF;
    IF EXISTS (SELECT 1 FROM contract o
                WHERE o.tenant_id = NEW.tenant_id AND o.id <> NEW.id
                  AND (   (NEW.pdf_file_id IS DISTINCT FROM OLD.pdf_file_id
                           AND (o.pdf_file_id = NEW.pdf_file_id OR o.signed_pdf_file_id = NEW.pdf_file_id))
                       OR (NEW.signed_pdf_file_id IS DISTINCT FROM OLD.signed_pdf_file_id
                           AND (o.pdf_file_id = NEW.signed_pdf_file_id OR o.signed_pdf_file_id = NEW.signed_pdf_file_id)))) THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract''s PDF is its own';
    END IF;
    IF NEW.pdf_file_id IS DISTINCT FROM OLD.pdf_file_id
       AND (OLD.pdf_file_id IS NOT NULL OR OLD.origin <> 'WRITTEN' OR OLD.status = 'DRAFT') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: the PDF as sent is set once, on a sent contract';
    END IF;
    IF NEW.signed_pdf_file_id IS DISTINCT FROM OLD.signed_pdf_file_id
       AND (OLD.signed_pdf_file_id IS NOT NULL OR OLD.origin <> 'WRITTEN' OR OLD.status <> 'SIGNED') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: the signed copy is set once, on a signed contract';
    END IF;
    IF (NEW.pdf_file_id IS NOT NULL AND NEW.pdf_file_id IS DISTINCT FROM OLD.pdf_file_id
        AND NOT EXISTS (SELECT 1 FROM file_object f WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.pdf_file_id AND f.kind = 'CONTRACT_PDF'))
       OR (NEW.signed_pdf_file_id IS NOT NULL AND NEW.signed_pdf_file_id IS DISTINCT FROM OLD.signed_pdf_file_id
        AND NOT EXISTS (SELECT 1 FROM file_object f WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.signed_pdf_file_id AND f.kind = 'CONTRACT_PDF')) THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract''s PDF is a contract PDF of its workspace';
    END IF;
    RETURN NEW;
  END IF;

  -- Everything else is a member's act, as themselves.
  IF who IS DISTINCT FROM 'member' THEN
    RAISE EXCEPTION 'CONTRACT_GUARD: only a contract''s PDF is the system''s to write';
  END IF;

  -- A DRAFT's edit.
  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
    IF NOT invoice_member_holds(OLD.tenant_id, who_id, 'contract:edit') THEN
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
  END IF;

  -- THE SEND.
  IF OLD.status = 'DRAFT' AND NEW.status = 'SENT' THEN
    IF NOT invoice_member_holds(OLD.tenant_id, who_id, 'contract:send') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract is sent by a member holding contract:send';
    END IF;
    IF NEW.sent_by_member_id IS DISTINCT FROM who_id OR NEW.sent_at IS NULL
       OR NEW.sent_at < at - slack OR NEW.sent_at > at + slack THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a member sends a contract as themselves, now';
    END IF;
    IF OLD.origin <> 'WRITTEN' OR OLD.body IS NULL
       OR NOT jsonb_path_exists(OLD.body, '$.** ? (@.type == "text")') THEN
      RAISE EXCEPTION 'CONTRACT_NOT_READY: a contract to send has its text';
    END IF;
    IF OLD.body::text ~ '[{][{](client_name|client_org_nr|client_address|signer_name|agency_name|agency_org_nr|agency_address|today)[}][}]' THEN
      RAISE EXCEPTION 'CONTRACT_FILL_INS_LEFT: a fill-in is still in the text';
    END IF;
    IF OLD.signer_contact_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM contact c
                       WHERE c.tenant_id = OLD.tenant_id AND c.id = OLD.signer_contact_id AND c.client_id = OLD.client_id
                         AND c.portal_status = 'ACTIVE' AND c.portal_profile = 'CONTACT_PRIMARY') THEN
      RAISE EXCEPTION 'CONTRACT_SIGNER_INVALID: the signer is a main contact of the client, in the portal';
    END IF;
    -- Every column a send does not write is as the draft left it.
    NEW.parties := OLD.parties; -- rebuilt below; the app's value never counts
    NEW.content_sha256 := OLD.content_sha256;
    IF (to_jsonb(NEW) - sending) IS DISTINCT FROM (to_jsonb(OLD) - sending) THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a send writes only what a send writes';
    END IF;
    SELECT tn.name, tn.legal_name, tn.org_nr, tn.address_line1, tn.address_line2, tn.postal_code, tn.city, tn.country_code
      INTO t FROM tenant tn WHERE tn.id = OLD.tenant_id;
    SELECT c.name, c.org_nr, c.address_line1, c.address_line2, c.postal_code, c.city, c.country_code
      INTO cl FROM client c WHERE c.tenant_id = OLD.tenant_id AND c.id = OLD.client_id;
    NEW.parties := jsonb_build_object(
      'agency', jsonb_build_object(
        'name', COALESCE(NULLIF(btrim(t.legal_name), ''), t.name),
        'orgNr', NULLIF(btrim(t.org_nr), ''),
        'addressLine1', NULLIF(btrim(t.address_line1), ''),
        'addressLine2', NULLIF(btrim(t.address_line2), ''),
        'postalCode', NULLIF(btrim(t.postal_code), ''),
        'city', NULLIF(btrim(t.city), ''),
        'countryCode', t.country_code),
      'client', jsonb_build_object(
        'name', cl.name,
        'orgNr', NULLIF(btrim(cl.org_nr), ''),
        'addressLine1', NULLIF(btrim(cl.address_line1), ''),
        'addressLine2', NULLIF(btrim(cl.address_line2), ''),
        'postalCode', NULLIF(btrim(cl.postal_code), ''),
        'city', NULLIF(btrim(cl.city), ''),
        'countryCode', cl.country_code));
    -- THE FINGERPRINT both signatures attest to: the frozen record, as
    -- Postgres writes it (jsonb's text form is canonical), hashed HERE.
    NEW.content_sha256 := encode(sha256(convert_to(jsonb_build_object(
      'id', NEW.id,
      'version', NEW.version,
      'client_id', NEW.client_id,
      'title', NEW.title,
      'language', NEW.language,
      'starts_on', NEW.starts_on,
      'ends_on', NEW.ends_on,
      'signer_contact_id', NEW.signer_contact_id,
      'parties', NEW.parties,
      'body', NEW.body)::text, 'UTF8')), 'hex');
    -- The signature rows' guard admits their INSERT during THIS send only.
    PERFORM set_config('app.contract_sent_now', NEW.id, true);
    RETURN NEW;
  END IF;

  -- WITHDRAW.
  IF OLD.status = 'SENT' AND NEW.status = 'WITHDRAWN' THEN
    IF NOT invoice_member_holds(OLD.tenant_id, who_id, 'contract:send') THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a contract is withdrawn by a member holding contract:send';
    END IF;
    IF NEW.withdrawn_by_member_id IS DISTINCT FROM who_id OR NEW.withdrawn_at IS NULL
       OR NEW.withdrawn_at < at - slack OR NEW.withdrawn_at > at + slack
       OR (to_jsonb(NEW) - withdrawing) IS DISTINCT FROM (to_jsonb(OLD) - withdrawing) THEN
      RAISE EXCEPTION 'CONTRACT_GUARD: a member withdraws a contract as themselves, now, and changes nothing else';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'DRAFT' AND NEW.status = OLD.status THEN
    RAISE EXCEPTION 'CONTRACT_NOT_DRAFT: a sent contract never changes';
  END IF;
  RAISE EXCEPTION 'CONTRACT_NOT_OPEN: that contract cannot move from % to %', OLD.status, NEW.status;
END
$fn$;


-- ── 3. contract_signature_guard ─────────────────────────────────────
CREATE OR REPLACE FUNCTION contract_signature_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := current_setting('app.principal', true);
  who_id text := current_setting('app.principal_id', true);
  maintenance boolean := current_setting('app.contract_maintenance', true) = 'on' AND current_user = 'app_platform';
  k record;
  person record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only with its contract (a draft's — none has any — or a tenant's
    -- teardown), never on its own.
    IF maintenance OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: a signature is never deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- During the send that marked this transaction, by its sender.
    IF who IS DISTINCT FROM 'member' OR current_setting('app.contract_sent_now', true) IS DISTINCT FROM NEW.contract_id THEN
      RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: signatures are written by the send';
    END IF;
    SELECT c.status, c.sent_by_member_id, c.signer_contact_id, c.content_sha256 INTO k
      FROM contract c
     WHERE c.tenant_id = NEW.tenant_id AND c.client_id = NEW.client_id AND c.id = NEW.contract_id;
    IF NOT FOUND OR k.status <> 'SENT' OR k.sent_by_member_id IS DISTINCT FROM who_id THEN
      RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: signatures are written by the send';
    END IF;
    NEW.content_sha256 := k.content_sha256;
    NEW.level := 'SES';
    NEW.ip := NULL;
    NEW.user_agent := NULL;
    NEW.created_at := clock_timestamp();
    IF NEW.party = 'TENANT' THEN
      -- The sender's own signature, made as they send (C84 (b)).
      IF NEW.signer_member_id IS DISTINCT FROM who_id OR NEW.signer_contact_id IS NOT NULL
         OR NEW.status <> 'SIGNED' OR NEW.typed_name IS NULL OR NEW.decline_reason IS NOT NULL THEN
        RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: the agency signs as the sender, as they send';
      END IF;
      SELECT u.name, u.email INTO person
        FROM member m JOIN "user" u ON u.id = m.user_id
       WHERE m.tenant_id = NEW.tenant_id AND m.id = who_id;
      NEW.decided_at := clock_timestamp();
    ELSE
      -- The client's row, waiting for the signer the contract names.
      IF NEW.signer_contact_id IS DISTINCT FROM k.signer_contact_id OR NEW.signer_member_id IS NOT NULL
         OR NEW.status <> 'PENDING' OR NEW.typed_name IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decline_reason IS NOT NULL THEN
        RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: the client''s signature waits for the contract''s signer';
      END IF;
      SELECT c.name, c.email INTO person
        FROM contact c
       WHERE c.tenant_id = NEW.tenant_id AND c.client_id = NEW.client_id AND c.id = NEW.signer_contact_id;
    END IF;
    IF person IS NULL THEN
      RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: a signer is a person of the record';
    END IF;
    -- Names and addresses from the record, never the app's.
    NEW.signer_name := person.name;
    NEW.signer_email := lower(person.email);
    RETURN NEW;
  END IF;

  -- UPDATE: only a contact deciding their own pending row (the census's
  -- policy and column trigger say which row and which columns; this says the
  -- move). Nobody else changes a signature.
  IF who IS DISTINCT FROM 'contact' THEN
    RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: only the signer decides, in the portal';
  END IF;
  IF OLD.party <> 'CLIENT' OR OLD.status <> 'PENDING' OR NEW.status NOT IN ('SIGNED', 'DECLINED')
     OR OLD.signer_contact_id IS DISTINCT FROM who_id THEN
    RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: a pending signature is decided once, by its signer';
  END IF;
  -- Dated by the DATABASE, whatever the signer's request said (the pre-apply
  -- review's low: a contact could otherwise backdate their own evidence).
  NEW.decided_at := clock_timestamp();
  IF NEW.status = 'SIGNED' AND NEW.decline_reason IS NOT NULL THEN
    RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: a signature gives no reason to decline';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER contract_signature_guard
  BEFORE INSERT OR UPDATE OR DELETE ON contract_signature
  FOR EACH ROW EXECUTE FUNCTION contract_signature_guard();

-- The census's column rule: a contact writes only these on their row.
CREATE TRIGGER contract_signature_portal_columns
  BEFORE UPDATE ON contract_signature
  FOR EACH ROW EXECUTE FUNCTION portal_contact_columns_only(
    'decided_at', 'decline_reason', 'ip', 'status', 'typed_name', 'user_agent'
  );


-- ── 4. The evidence, moved off the client-readable row ──────────────
-- SECURITY DEFINER: the class-A evidence row is written for the contact,
-- who may write no class-A row. It fires only on the contact's own decision
-- (the guard above has already refused every other update), copies the two
-- values and clears them, so the row is written without them (the CHECK).
CREATE OR REPLACE FUNCTION contract_signature_evidence_move() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.ip IS NOT NULL OR NEW.user_agent IS NOT NULL THEN
    INSERT INTO contract_signature_evidence (id, tenant_id, signature_id, ip, user_agent, created_at)
    VALUES (gen_random_uuid()::text, NEW.tenant_id, NEW.id, left(NEW.ip, 100), left(NEW.user_agent, 500), clock_timestamp());
  END IF;
  NEW.ip := NULL;
  NEW.user_agent := NULL;
  RETURN NEW;
END
$fn$;

-- "zz_": after the guard and the column rule (BEFORE triggers fire in name order).
CREATE TRIGGER contract_signature_zz_evidence
  BEFORE UPDATE OF status ON contract_signature
  FOR EACH ROW
  WHEN (OLD.status = 'PENDING' AND NEW.status <> 'PENDING' AND OLD.party = 'CLIENT')
  EXECUTE FUNCTION contract_signature_evidence_move();


-- ── 5. The contract moved by the signature ──────────────────────────
CREATE OR REPLACE FUNCTION contract_signature_decided() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  tz text;
  moved int;
BEGIN
  -- The workspace's day, in its own time zone (the preference; a value that
  -- is not a zone falls back to the product's default).
  SELECT p.value #>> '{}' INTO tz FROM tenant_preference p
   WHERE p.tenant_id = NEW.tenant_id AND p.key = 'ui.timezone';
  IF tz IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = tz) THEN
    tz := 'Europe/Stockholm';
  END IF;
  PERFORM set_config('app.contract_decided', NEW.contract_id, true);
  UPDATE contract c
     SET status = CASE WHEN NEW.status = 'SIGNED' THEN 'SIGNED'::contract_status ELSE 'DECLINED'::contract_status END,
         signed_on = CASE WHEN NEW.status = 'SIGNED' THEN (clock_timestamp() AT TIME ZONE tz)::date ELSE NULL END
   WHERE c.tenant_id = NEW.tenant_id AND c.client_id = NEW.client_id AND c.id = NEW.contract_id
     AND c.status = 'SENT' AND c.content_sha256 = NEW.content_sha256;
  GET DIAGNOSTICS moved = ROW_COUNT;
  PERFORM set_config('app.contract_decided', '', true);
  IF moved <> 1 THEN
    RAISE EXCEPTION 'CONTRACT_NOT_OPEN: that contract is no longer waiting for a signature';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER contract_signature_decided
  AFTER UPDATE OF status ON contract_signature
  FOR EACH ROW
  WHEN (OLD.status = 'PENDING' AND NEW.status <> 'PENDING' AND NEW.party = 'CLIENT')
  EXECUTE FUNCTION contract_signature_decided();

-- Only the triggers call these.
REVOKE ALL ON FUNCTION contract_signature_evidence_move() FROM PUBLIC;
REVOKE ALL ON FUNCTION contract_signature_decided() FROM PUBLIC;


-- ── 6. A sent contract has both its rows, at commit ─────────────────
CREATE OR REPLACE FUNCTION contract_sent_signatures() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF (SELECT count(*) FROM contract_signature s
       WHERE s.tenant_id = NEW.tenant_id AND s.contract_id = NEW.id AND s.party = 'TENANT' AND s.status = 'SIGNED') <> 1
     OR (SELECT count(*) FROM contract_signature s
          WHERE s.tenant_id = NEW.tenant_id AND s.contract_id = NEW.id AND s.party = 'CLIENT') <> 1 THEN
    RAISE EXCEPTION 'CONTRACT_SIGNATURE_GUARD: a sent contract carries the agency''s signature and the client''s';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER contract_sent_signatures
  AFTER UPDATE OF status ON contract
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.status = 'DRAFT' AND NEW.status = 'SENT')
  EXECUTE FUNCTION contract_sent_signatures();


-- ── 7. Grants ───────────────────────────────────────────────────────
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.
GRANT SELECT, INSERT, UPDATE ON contract_signature TO app_runtime;
-- The evidence is written by its definer only; members read it.
GRANT SELECT ON contract_signature_evidence TO app_runtime;


-- ── 8. RLS: contract_signature — class B ────────────────────────────
ALTER TABLE contract_signature ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_signature FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON contract_signature
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

-- A contact sees the signature rows of a contract they can see (its
-- `portal_gate` decides, read under their own RLS), of their own client.
-- WITH CHECK keeps the same terms, so their own decision is written back
-- only onto such a row (§10 item 6 (a): not the invoice's "contacts never").
CREATE POLICY portal_gate ON contract_signature
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND EXISTS (SELECT 1 FROM contract k WHERE k.tenant_id = contract_signature.tenant_id AND k.id = contract_signature.contract_id)
    )
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND EXISTS (SELECT 1 FROM contract k WHERE k.tenant_id = contract_signature.tenant_id AND k.id = contract_signature.contract_id)
    )
  );

-- Contracts are a MAIN contact's (AUTHZ §8): their signature rows too.
CREATE POLICY portal_signature_primary ON contract_signature
  AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (SELECT EXISTS (
          SELECT 1 FROM contact c
           WHERE c.id = current_setting('app.principal_id', true)
             AND c.portal_profile = 'CONTACT_PRIMARY'))
  );

-- The census's named denies for what a contact never does here.
CREATE POLICY portal_no_insert ON contract_signature
  AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

CREATE POLICY portal_no_delete ON contract_signature
  AS RESTRICTIVE FOR DELETE TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- THE CENSUS WRITE: a contact decides their own CLIENT row, signed or
-- declined and dated, while they are still a MAIN contact ACTIVE in the
-- portal (§10 item 6 (d) — checked at signing too, not only at sending). The
-- house shape: WITH CHECK only; "PENDING before" is the guard's transition.
CREATE POLICY portal_signature_decide ON contract_signature
  AS RESTRICTIVE FOR UPDATE TO app_runtime
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      party = 'CLIENT'
      AND signer_contact_id = (SELECT current_setting('app.principal_id', true))
      AND status IN ('SIGNED', 'DECLINED')
      AND decided_at IS NOT NULL
      AND (SELECT EXISTS (
            SELECT 1 FROM contact c
             WHERE c.id = current_setting('app.principal_id', true)
               AND c.portal_status = 'ACTIVE'
               AND c.portal_profile = 'CONTACT_PRIMARY'))
    )
  );


-- ── 9. RLS: contract_signature_evidence — class A ───────────────────
ALTER TABLE contract_signature_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_signature_evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON contract_signature_evidence
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON contract_signature_evidence
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');


-- ── 10. A contract's PDF file never changes ─────────────────────────
-- The invoice PDF's guard and CHECK (20261009200000), for CONTRACT_PDF: the
-- PDF as sent and the signed copy are the record drawn once, kept as they
-- were stored; written COMMITTED, never PENDING (a PENDING one, frozen here,
-- would stall the pending-upload sweep).
CREATE OR REPLACE FUNCTION file_object_contract_pdf_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF (OLD.kind = 'CONTRACT_PDF' OR NEW.kind = 'CONTRACT_PDF')
     AND (   NEW.kind IS DISTINCT FROM OLD.kind
          OR NEW.id IS DISTINCT FROM OLD.id
          OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
          OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
          OR NEW.r2_key IS DISTINCT FROM OLD.r2_key
          OR NEW.sha256 IS DISTINCT FROM OLD.sha256
          OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
          OR NEW.content_type IS DISTINCT FROM OLD.content_type
          OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'FILE_CONTRACT_PDF_GUARD: a contract''s PDF file never changes';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER file_object_contract_pdf_guard
  BEFORE UPDATE ON file_object
  FOR EACH ROW EXECUTE FUNCTION file_object_contract_pdf_guard();

ALTER TABLE file_object
  ADD CONSTRAINT file_object_contract_pdf_committed CHECK (kind <> 'CONTRACT_PDF' OR status = 'COMMITTED');
