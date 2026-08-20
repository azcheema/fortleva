-- §6.18: "dedupeKey collapses repeats (unique per tenant while
-- unread)" — as a DB constraint, because notify.emit runs under the
-- ACTOR's principal and principal_scope deliberately blinds it to the
-- receiver's existing rows: an app-level pre-check cannot see them.
-- emit inserts with skipDuplicates per receiver and reads the count —
-- the constraint IS the dedupe, race-safe by construction.
CREATE UNIQUE INDEX notification_dedupe_unread ON notification
  (tenant_id, receiver_type, receiver_id, dedupe_key)
  WHERE read_at IS NULL AND archived_at IS NULL AND dedupe_key IS NOT NULL;
