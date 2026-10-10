/**
 * Business-rule failures that are neither authorization denials
 * (AuthzError) nor bugs: the caller (server action) maps `code` to an
 * i18n message. Codes are a closed union so the UI catalog stays exact.
 */
export type DomainErrorCode =
  | "NAME_REQUIRED"
  | "KEY_INVALID" // Project.key must match ^[A-Z][A-Z0-9]{0,7}$
  | "KEY_TAKEN" // Project.key unique per tenant
  | "EMAIL_INVALID"
  | "EMAIL_TAKEN" // Contact.email unique
  | "VERSION_TAKEN" // ProjectVersion.version unique per project
  | "ALREADY_SHIPPED"
  | "ARCHIVED" // mutation on an archived client/project
  | "CLIENT_MISMATCH" // projectId does not belong to clientId
  | "INVALID_INPUT"
  | "APPROVAL_REQUIRED" // entering a requiresApproval WorkflowState without work_item:approve (2W-R)
  // Portal switch (slice 43 — src/projects/service.ts). A statement in the switch's
  // transaction — in practice the fan-out, but the bound covers them all — could not
  // take its row locks past a concurrent writer within lockTimeoutMs, on every attempt.
  | "PORTAL_SWITCH_BUSY"
  // View-as-Contact (slice 5 — src/clients/view-as.ts). The member holds
  // the permission and reaches the client, but this CONTACT cannot be
  // looked through: not ACTIVE, never invited, or an unverified address.
  // A refusal the member can act on, which is why it is a DomainError and
  // not an AuthzError — the member IS the agency, and "nobody can sign in
  // as this person yet" is a fact about their own tenant (AUTHZ §8's
  // member-side half, the same reasoning as the Portal tab's blockers).
  | "CONTACT_NOT_VIEWABLE"
  // The contact lifecycle's five refusals (the invite slice's SURFACES —
  // src/clients/contact-access.ts and `deleteContact`). Every one of
  // these was `INVALID_INPUT` while the server half had no caller, which
  // was harmless then and is not now: `messageForError` renders
  // `domainErrors.INVALID_INPUT` — "Invalid input." — and a member who
  // has just pressed Pause on a contact who is not active would have been
  // told nothing at all. A refusal a member can act on earns a code; the
  // detail string never crosses the boundary.
  | "CONTACT_NOT_INVITABLE" // only NO_ACCESS, INVITED (a resend) or REVOKED (a fresh start, C28)
  | "INVITE_IN_FLIGHT" // the partial unique: one live invitation per contact
  | "ACCESS_TRANSITION_INVALID" // pause a non-active, resume a non-paused, remove what has no access
  | "CONTACT_HAS_ACCESS" // erasure refused while the person can still sign in
  | "CONTACT_HAS_HISTORY" // erasure refused for somebody who has written in the portal
  // A pause / resume / removal of a contact's access that lost a deadlock on
  // every attempt (Phase 3 slice 72: REMOVE releases the contact's tasks,
  // which can cycle with a make-private cascade). Nothing was written.
  | "CONTACT_ACCESS_BUSY"
  // C29: deleting an ANSWERED client request would erase the agency's
  // own reply from the client's list, because `listPortalTasks` filters
  // `deletedAt` at the top level. An unanswered one is still deletable
  // (a recorded residual — OPEN_QUESTIONS C29); archiving is always
  // allowed and stays visible to the client.
  | "REQUEST_ANSWER_IS_THE_CLIENTS"
  // Portal request intake (slice 6a — src/modules/work/portal-writes.ts).
  // This contact has submitted the most requests the window allows. It is
  // the ONE refusal the portal states plainly rather than collapsing into
  // its uniform empty answer, because it is a fact about the READER —
  // they did this, they can wait and do it again — and not about the
  // agency's plan, settings or other clients (src/portal/render.ts draws
  // that line; `src/portal/action.ts` applies it to writes).
  | "REQUEST_RATE_LIMITED"
  // ...and the OTHER refusal that path can raise: a submission whose
  // advisory-lock waits were spent (55P03) or which lost a deadlock,
  // every attempt. Deliberately NOT on `src/portal/action.ts`'s
  // disclosure list — "your agency is running something big on this
  // project right now" is a fact about the agency — so a contact sees
  // the plane's one generic refusal and the reason goes to the log.
  | "REQUEST_BUSY"
  // This contact has downloaded the most files the window allows (Phase
  // 3, the portal files slice). Disclosed for the same reason
  // REQUEST_RATE_LIMITED is: a fact about the READER's own behaviour.
  | "DOWNLOAD_RATE_LIMITED"
  // ...and the download's `REQUEST_BUSY`: its budget lock's waits were
  // spent (55P03) or it lost a deadlock, every attempt. Not disclosable,
  // for the same reason — the contact sees the plane's generic refusal.
  | "DOWNLOAD_BUSY"
  // This contact has written the most comments the window allows (Phase
  // 3 slice 75, `src/modules/work/portal-comment.ts`). Disclosed for the
  // same reason REQUEST_RATE_LIMITED is: a fact about the READER's own
  // behaviour. A spent lock wait on that path is `REQUEST_BUSY`, which
  // is not disclosed.
  | "COMMENT_RATE_LIMITED"
  // This contact has handed over the most logins the window allows (Phase
  // 3V slice 96, `src/modules/vault/submission-portal-writes.ts`).
  // Disclosed for the same reason REQUEST_RATE_LIMITED is: a fact about the
  // READER's own behaviour. A spent lock wait on that path is VAULT_BUSY,
  // which is not disclosed.
  | "SUBMISSION_RATE_LIMITED"
  // The vault (Phase 3V slice 1 — src/modules/vault/reveal.ts): this member
  // has revealed, copied or generated codes as many times as the tenant's
  // `vault.revealBudgetPerHour` allows in the last hour. A fact about the
  // member's own use, recorded (`vault.reveal_budget_exceeded`) — the
  // budget exists so that bulk exfiltration by a legitimate member is
  // slow and loud (SECURITY.md §6.3).
  | "REVEAL_BUDGET_EXCEEDED"
  // ...and the vault's BUSY: a reveal or a secret change whose lock waits
  // were spent (55P03) or which lost a deadlock, every attempt. Nothing was
  // revealed or written; "try again" is the truth and the whole remedy.
  | "VAULT_BUSY"
  // Share links (Phase 3V slice 90 — src/modules/vault/share-links.ts):
  // the workspace has them switched off (`vault.allowExternalShareLinks`),
  // and a revoke of a link that has already been opened or revoked.
  | "SHARE_LINKS_OFF"
  | "SHARE_LINK_CLOSED"
  // Logins shown to clients (Phase 3V slice 91 — src/modules/vault/
  // visibility.ts): the workspace has them switched off
  // (`vault.allowPortalCredentials`), so a login cannot be shown; and a
  // login with no client (the agency's own, C49), which has nobody to be
  // shown to.
  | "CLIENT_LOGINS_OFF"
  | "LOGIN_HAS_NO_CLIENT"
  // A SEALED login (Phase 3V slice 92 — src/modules/vault/seal.ts; founder
  // decision C60 (a)): kept for its client, who gets it only by asking, so
  // it is never shown to the client nor sent with a share link. (Sealing
  // one with no client is LOGIN_HAS_NO_CLIENT.)
  | "LOGIN_SEALED"
  // A client's ask to open their sealed logins (Phase 3V slice 93 —
  // src/modules/vault/sealed-requests.ts; C61 (c)) can be approved or denied
  // only until it opens: an answer to one that has opened, closed, lapsed,
  // or been denied or withdrawn meanwhile is refused, and says so.
  | "SEALED_REQUEST_SETTLED"
  // Asking a client for a login (Phase 3V slice 98 — src/modules/vault/
  // asks.ts; founder decision C66), said to the MEMBER: the workspace has
  // "Logins sent by clients" switched off, or the portal module is closed,
  // so nobody at the client could answer; the person picked cannot receive
  // an ask (no portal access now, or not that client's); they already have
  // the most open asks one person may hold (`ASKS_OPEN_PER_CONTACT`); and
  // a cancellation of an ask that has already been sent, declined or
  // cancelled — which says so.
  | "LOGIN_ASKS_OFF"
  | "LOGIN_ASK_CONTACT"
  | "LOGIN_ASK_LIMIT"
  | "LOGIN_ASK_ENDED"
  // The export (Phase 3V slice 95 — src/modules/vault/export.ts; C63): the
  // member asked for logins they reach none of (an empty choice, or our
  // own without a tenant-wide scope — the same answer, C49), or for more
  // than one file carries (`EXPORT_MAX`) — export one client at a time.
  | "NOTHING_TO_EXPORT"
  | "EXPORT_TOO_LARGE"
  // Quiet hours (Phase 5 slice 105 — src/notify/preferences.ts; C73 (f)):
  // a start and an end on the same hour is no window at all. The form never
  // offers it; a hand-made request is told so.
  | "QUIET_HOURS_SAME"
  // Progress-update layouts (slice 105 — src/modules/work/update-templates.ts;
  // C73 (c), (d), (g)): a name the workspace already uses (whatever its
  // case); a layout another member changed or deleted while this one was
  // saving it (the default swap, a delete racing a project's pick).
  | "LAYOUT_NAME_TAKEN"
  | "LAYOUT_BUSY"
  // An owner's reset / sign-out of a teammate (slice 84, C50 —
  // src/auth/member-reset.ts): aimed at themselves; at a console
  // principal, whose sign-in is the operator's; a reset of somebody who
  // belongs to another workspace too; a reset with nothing to reset.
  | "ACCOUNT_IS_YOURS"
  | "ACCOUNT_IS_OPERATORS"
  | "ACCOUNT_IN_OTHER_WORKSPACE"
  | "TWO_FACTOR_NOT_ENROLLED"
  // Sign-off (Phase 3 — src/projects/versions.ts, src/documents/service.ts).
  // The member's three refusals when ASKING a client to sign off: the row
  // is not something the client can see (a draft version, an INTERNAL or
  // non-DELIVERABLE document, a project whose portal is off, a document
  // with no committed bytes); the ask is already open; or the client has
  // already approved and there is nothing left to ask. Each is a fact
  // about the member's own tenant and earns a sentence. The CONTACT'S
  // side raises none of these: a decision on a row that is not PENDING
  // is answered with the row's current state, and everything else is
  // the plane's uniform NOT_FOUND.
  | "SIGNOFF_NOT_SHAREABLE"
  | "SIGNOFF_ALREADY_REQUESTED"
  | "SIGNOFF_ALREADY_APPROVED"
  // Work tree (2W — trigger tokens map 1:1 in src/modules/work/db-errors.ts)
  | "HAS_VISIBLE_CHILDREN" // make-private refused while client-visible subtasks/comments/attachments live
  // The sharing UI (Phase 3 slice 72 — src/modules/work/visibility.ts): a
  // make-private cascade or a bulk share whose lock waits were spent
  // (55P03) or which lost a deadlock, every attempt. Nothing was written;
  // "try again" is the truth and the whole remedy, the portal switch's
  // PORTAL_SWITCH_BUSY shape.
  | "VISIBILITY_BUSY"
  | "PARENT_NOT_VISIBLE" // a child cannot be client-visible under an internal parent
  | "CANNOT_NEST" // parent type must be strictly higher (EPIC > TASK > SUBTASK)
  | "HAS_CHILDREN" // delete refused while live subtasks exist
  | "DESCRIPTION_TOO_LARGE" // the description's JSON or its extracted text is past its cap
  | "STALE_DESCRIPTION" // someone else saved this description while this editor held it
  // Comments (2W panel slice 10 — the trigger token maps in src/modules/work/db-errors.ts)
  | "COMMENT_EMPTY" // a comment with no text
  | "COMMENT_TOO_LARGE" // the comment's JSON or its extracted text is past its cap
  | "SUBJECT_NOT_VISIBLE" // a comment cannot be client-visible on a task the client cannot see
  // Labels (2W panel slice 12 — src/modules/work/labels.ts)
  | "LABEL_TAKEN" // a label with that name already exists (case-insensitive, tenant-wide)
  // Time (2T — DATA_MODEL.md §6.15; trigger tokens map 1:1 in src/modules/time/ctx.ts)
  | "NOTICE_UNACKNOWLEDGED" // staff notice not acknowledged — timers and clock-in refuse
  | "TIMER_ALREADY_RUNNING" // one running timer per member (partial unique)
  | "TIMER_NOT_RUNNING"
  | "SHIFT_ALREADY_OPEN"
  | "SHIFT_NOT_OPEN"
  | "BREAK_ALREADY_OPEN"
  | "BREAK_NOT_OPEN"
  | "SHIFTS_DISABLED" // time.shiftsEnabled = false
  | "ADHOC_DISABLED" // time.allowAdhocEntries = false
  | "DESCRIPTION_REQUIRED" // ad-hoc or project-level entry without a note
  | "ITEM_REQUIRED" // time.allowEntriesWithoutItem = false
  | "TARGET_MISMATCH" // work item is not in the given project
  | "OVERLAP_BLOCKED" // tenant switched time.allowOverlap off
  | "ENTRY_LOCKED" // invoiced / locked entry (trigger)
  | "INVALID_DURATION"
  | "ENDS_IN_FUTURE" // a positioned entry may not end in the future (create and edit, with a minute of slack)
  | "SPLIT_TOO_SHORT" // a split must leave both halves at least a whole minute
  | "SERVICE_CLIENT_MISMATCH" // agreement belongs to another client/project (trigger)
  | "RATE_OVERLAP" // EXCLUDE rate_card_no_overlap
  | "RATE_CARD_IMMUTABLE" // trigger
  | "REPORT_IMMUTABLE" // published TimeReport (trigger)
  // A report whose snapshot names a task (or its epic) that is no longer
  // CLIENT_VISIBLE — it was generated while the task was shared, and the
  // task has been made private since. Refused at publish and republish
  // (Phase 3 slice 72): the snapshot is frozen, so the only honest answer
  // is a fresh one.
  | "REPORT_NAMES_PRIVATE_TASK"
  // The report was regenerated, deleted, archived — or published by a
  // colleague first — while it was being published (the check it passed
  // was of another version, or the verb no longer applies). Nothing was
  // published.
  | "REPORT_CHANGED"
  | "BREAK_OUT_OF_BOUNDS" // trigger
  | "SHIFT_SHRINK" // trigger
  | "WORK_TYPE_TAKEN" // live name unique per tenant
  // Progress updates (Phase 3 — DATA_MODEL.md §6.16; the trigger token
  // maps in src/modules/work/db-errors.ts)
  | "UPDATE_IMMUTABLE" // a published update cannot be edited (trigger) — retract within 15 min, or add a note
  | "UPDATE_NOT_DRAFT" // the verb wanted a draft: edit, discard, publish
  | "UPDATE_NOT_PUBLISHED" // the verb wanted a published post: archive, visibility, annotate, retract
  | "UPDATE_RETRACT_WINDOW_CLOSED" // more than 15 minutes since publishing
  | "UPDATE_CHANGED" // the draft was saved by somebody else between the two publish transactions
  | "UPDATE_EMPTY" // publishing a post whose sections say nothing
  | "UPDATE_TOO_LARGE" // a section's JSON or its extracted text is past its cap
  // The workspace's reply address (Phase 5 slice 100 — src/notify/reply-address.ts).
  | "REPLY_ADDRESS_INVALID" // not an address, or one on the domain Fortleva sends from (it receives nothing)
  | "REPLY_ADDRESS_UNCHANGED" // already the confirmed address
  | "REPLY_ADDRESS_UNDELIVERABLE" // the address bounced or complained before: mail to it is suppressed
  | "REPLY_ADDRESS_LIMIT" // five confirmation mails a day per workspace, or three a day to one address
  | "REPLY_ADDRESS_MAIL_FAILED" // the confirmation mail could not be sent; nothing waits on a link nobody got
  // Phone and browser notifications (Phase 5 slice 106 — src/push/devices.ts).
  | "PUSH_UNAVAILABLE" // this server has no VAPID key pair: nothing can be turned on
  | "PUSH_DEVICE_INVALID" // not one of the four push services, or keys no push could use
  | "PUSH_DEVICE_LIMIT" // ten devices already — remove one first
  | "PUSH_RATE_LIMITED" // twenty turn-ons an hour per member: a fact about the reader's own behaviour
  // Invoicing (Phase 4 slice 107 — src/modules/invoicing). The workspace's
  // details are typo-checked before they are printed on every invoice.
  | "ORG_NR_INVALID" // not ten digits with a correct check digit
  | "VAT_NUMBER_INVALID" // not SE + the org. number's ten digits + 01
  | "BANKGIRO_INVALID" // not 7–8 digits with a correct check digit
  | "PLUSGIRO_INVALID" // not 2–8 digits with a correct check digit
  | "IBAN_INVALID" // shape or the mod-97 check
  | "BIC_INVALID" // not 8 or 11 characters of the BIC shape
  | "INVOICE_NOT_DRAFT" // the verb wanted a draft; the invoice was issued meanwhile (trigger)
  | "INVOICE_LINE_LIMIT" // two hundred lines on one invoice
  | "INVOICE_LINE_DESCRIPTION_REQUIRED" // a line says what was sold
  | "INVOICE_AMOUNT_TOO_LARGE" // a line's amount past what an invoice holds
  | "INVOICE_RATE_NOT_ALLOWED" // a VAT rate the invoice's VAT treatment does not have
  // Phase 4 slice 108 — issuing (src/modules/invoicing/issue.ts, series.ts, fx.ts).
  | "INVOICE_NOT_READY" // something issuing needs is missing (the dialog names what) — or the guard found it so
  | "INVOICE_CHANGED" // the draft or its client changed since the issuer looked (the fingerprint), or since the rate was fetched
  | "INVOICE_FX_UNAVAILABLE" // the ECB's rate could not be fetched or read: try again, never a guessed rate
  | "INVOICE_FX_TOO_OLD" // the work ended before the ECB's 90-day history reaches (C78 (a), slice 108b)
  | "INVOICE_SERIES_IN_USE" // the first number is fixed once an invoice has one
  | "INVOICE_ISSUE_BUSY" // the series stayed held past the issue's lock bound (55P03): try again
  | "INVOICE_PDF_UNAVAILABLE" // an issued invoice's PDF could not be made just now
  // Phase 4 slice 108b — credit notes (src/modules/invoicing/credit.ts).
  | "INVOICE_NOT_CREDITABLE" // not an issued invoice, a credit note, or credited in full already
  | "INVOICE_PARTLY_CREDITED" // "the whole invoice" after part of it was credited — credit what is left as a part
  | "INVOICE_CREDIT_REASON_REQUIRED" // a credit note says why (C77 (b))
  // Phase 4 slice 109 — sending, Pay now, paid by hand (C79).
  | "INVOICE_PAY_LINK_REFUSED" // a Pay now link that is not a Stripe or PayPal payment page (C79 (f))
  | "INVOICE_PAY_LINK_CODE" // issuing an invoice with a Pay now link takes the code typed now (C79 (g))
  | "INVOICE_ALREADY_SENT" // "Mark as sent" on an invoice already sent
  | "INVOICE_JUST_SENT" // the same invoice emailed under a minute ago — a double click
  | "INVOICE_SEND_LIMIT" // the sending budget: per member per hour, per workspace per day
  | "INVOICE_NOT_PAYABLE" // marking paid: a credit note, a draft, or paid/credited already
  | "INVOICE_PAID_ON" // the day a payment arrived: not in the future, not long before the invoice
  | "INVOICE_NOT_PAID" // "Mark as unpaid" on an invoice that is not marked paid
  // Phase 4 slice 110 — hours onto invoices (src/modules/invoicing/hours.ts; C80).
  | "HOURS_CHANGED" // some of the chosen hours changed, were taken or are being worked on meanwhile — look again
  | "HOURS_NOTHING_TO_BILL" // the chosen hours bill nothing under their project's rounding
  | "HOURS_MIXED_CURRENCY" // the chosen hours are priced in more than one currency
  | "HOURS_TOO_MANY" // more hours chosen than one action takes
  | "INVOICE_HOURS_KEPT" // an issued invoice keeps its hours until a credit note corrects it
  | "INVOICE_HAS_HOURS" // a draft holding tracked hours keeps their currency
  | "ENTRY_INVOICED" // an hour on a draft invoice is not split until its line is removed
  // Phase 4 slice 111 — the bookkeeping file (src/modules/invoicing/bookkeeping.ts; C82).
  | "INVOICE_EXPORT_NO_METHOD" // the workspace has not chosen how it books invoices (Settings → Invoicing)
  | "INVOICE_EXPORT_EMPTY" // nothing new since the last file
  | "INVOICE_EXPORT_BUSY" // another file was being made, or an invoice was being marked paid: try again
  | "INVOICE_EXPORT_METHOD_FIXED" // the method is fixed once a file has been made
  // Phase 4 slice 111b — the cash method's year end (bookkeeping.ts; C83).
  | "INVOICE_YEAR_END_NOT_DUE" // that year end is not due — already booked, or the year hasn't ended
  | "INVOICE_YEAR_END_WAITING" // entries dated in that year still wait for a file: make files first
  | "INVOICE_YEAR_END_CHANGED" // the unpaid invoices changed since the page was read: look again
  | "INVOICE_YEAR_CLOSED"; // an invoice or credit note dated in a year whose year end is booked

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "DomainError";
  }
}

export const fail = (code: DomainErrorCode, detail?: string): never => {
  throw new DomainError(code, detail);
};

/** Prisma unique-violation duck test (no runtime import of the client — one-seam rule). */
export const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";

/**
 * Postgres DEADLOCK (SQLSTATE 40P01), duck-tested the same way and for
 * the same reason — no runtime import of the generated client.
 *
 * A deadlock is not a bug in the caller and not a state the data is in:
 * Postgres detects the cycle, picks a victim, aborts exactly one of the
 * transactions and lets the other finish. The victim's work is simply
 * undone, so redoing it is the textbook remedy and the only one — there
 * is nothing to "handle" and nothing to report to the member.
 *
 * THREE SHAPES, because Prisma surfaces the same 40P01 three ways, and
 * WHICH ONE depends on the statement that hit it — verified against the
 * installed runtime rather than inferred (review), because the first
 * draft of this accepted only the raw one and would therefore have
 * missed every case the retry is actually for:
 *   • P2010 — a `$queryRaw`. `@prisma/adapter-pg` has no mapping for
 *     40P01, so it stays `kind: "postgres"` and the client's raw branch
 *     wraps it.
 *   • P2039 — ANY model call (`tx.milestone.update`, a `record()` audit
 *     write). The same driver error down the client's non-raw branch.
 *     This is the one that matters: once a queue lock has removed the
 *     cycle two rank writers made between themselves, what is LEFT is a
 *     cycle through another table, and that is a model call by
 *     definition.
 *   • P2034 — Prisma's own write-conflict/deadlock code.
 * The nested driver shape (`meta.driverAdapterError.cause.code`) is too
 * brittle to walk, and both the code and the words appear in the
 * message Prisma builds for all three, so that is what this reads.
 *
 * Found on CI run 35440299558, where four concurrent milestone reorders
 * deadlocked on `SELECT … FOR UPDATE` and `retryOnRankCollision` —
 * which tested only for P2002 — rethrew it as a 500.
 */
const DEADLOCK_CODES = new Set(["P2010", "P2039", "P2034"]);

/**
 * Postgres LOCK TIMEOUT (SQLSTATE 55P03, "canceling statement due to
 * lock timeout") — the OTHER shape contention takes, and the reason
 * `isDeadlock` alone was never enough.
 *
 * A deadlock is a CYCLE: Postgres sees it, picks a victim and aborts
 * it. A writer that merely waits on a row another transaction holds is
 * not a cycle, so nothing is detected and nothing is aborted — it waits
 * until it gets the lock or something cancels it. Only a transaction
 * that ASKED for a bound (`withTenant`'s `lockTimeoutMs`) can raise
 * this at all, and without one there is no reliable end to the wait at
 * all: `lock_timeout` defaults to 0 and Prisma's transaction timeout is
 * enforced around the queries it issues, not inside one the DATABASE
 * has parked. Measured, not assumed — a blocked fan-out with a 3 s
 * transaction budget was still waiting past 30 s
 * (`portal-contention.dbtest.ts`). Anywhere this repo says such a wait
 * "dies as P2028", that sentence predates the measurement.
 *
 * Duck-tested for the same reason as the deadlock test — no runtime
 * import of the generated client — and reading the same two wrappers,
 * since Prisma has no code of its own for 55P03: P2010 for a
 * `$queryRaw`, P2039 for any model call. Both carry the SQLSTATE and
 * the words in the message Prisma builds, which is what this reads.
 *
 * P2039 IS MEASURED, P2010 IS CARRIED OVER. `portal-contention.dbtest`
 * provokes a real 55P03 through `setPortalEnabled` rather than
 * synthesising one, and a mutation check with this set emptied printed
 * the arriving error verbatim: `PrismaClientKnownRequestError`,
 * `code: "P2039"` — the fan-out rides a model call
 * (`tx.project.update`), so that is the branch this needs. P2010 is
 * here by the same symmetry the deadlock test rests on rather than by
 * measurement: nothing in the product yet waits on a lock from a
 * `$queryRaw` under a bound, so there is no way to provoke it without
 * writing a caller that does. Keep it, and do not claim it is proven.
 *
 * (CORRECTED 2026-09-28, slice 74. "Nothing in the product yet waits on
 * a lock from a raw statement under a bound" stopped being true with the
 * portal request intake (slice 6a, 2026-09-21): `createPortalRequest`
 * passes `lockTimeoutMs` and takes the raw advisory budget lock and the
 * rank queue inside it — and then the portal download (slice 69), with
 * `portal_download:`. The first MEASUREMENT of a raw 55P03 came later,
 * in slice 72: the make-private cascade queues on the rank lock with
 * `lockProjectRanks`, a `$executeRaw` advisory wait under
 * `lockTimeoutMs`, and `visibility.dbtest.ts` ("a cascade that cannot
 * get its locks is told VISIBILITY_BUSY…") holds that lock until the
 * bound fires. `VISIBILITY_BUSY` is reachable from a 55P03 only through
 * this function, so a raw statement's lock timeout IS matched — measured.
 * What that test does not do is print the arriving code, so "P2010" for
 * it rests on the raw branch the deadlock note above verified, not on a
 * printout. Slice 74 adds three more bounded raw advisory waits, all in
 * `src/projects/portal-gate.ts`: the portal switch's gate entry
 * (`beginPortalSwitch`, whose timeout must become PORTAL_SWITCH_BUSY on
 * the emergency control), the request broker's (`enterPortalGateShared`)
 * and the reconcile's.)
 */
const LOCK_TIMEOUT_CODES = new Set(["P2010", "P2039"]);

export const isLockTimeout = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string" || !LOCK_TIMEOUT_CODES.has(code)) return false;
  const message = String((e as { message?: unknown }).message ?? "");
  return /55P03|lock timeout/i.test(message);
};

export const isDeadlock = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string" || !DEADLOCK_CODES.has(code)) return false;
  // P2034 is a deadlock by definition; the other two are generic
  // wrappers and must say so.
  if (code === "P2034") return true;
  const message = String((e as { message?: unknown }).message ?? "");
  return /40P01|deadlock detected/i.test(message);
};
