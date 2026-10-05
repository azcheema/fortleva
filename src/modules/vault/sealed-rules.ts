import type { AskWaitRules } from "@/lib/ask-and-wait";

/**
 * THE SEALED LAYER'S FIGURES (Phase 3V slice 93; founder decisions C52
 * (f)–(h), C61) for the one ask-and-wait machine (`@/lib/ask-and-wait`).
 * The database holds every one of them too — migration 20261005220000's
 * CHECKs and its guard, in hours — and `sealed-rules.test.ts` pins these to
 * that file, so the two cannot drift apart. The wait itself is the
 * agency's (`vault.sealedWaitDays`, 7–60), frozen on each ask.
 */
export const SEALED_RULES: AskWaitRules = {
  /** C52 (f): "opens in 48 hours" after the client confirms. */
  noticeHours: 48,
  /** C52 (h): open 7 days, then it locks again. */
  openDays: 7,
  /** An unconfirmed ask lapses 30 days after its wait (decided while building, slice 93). */
  confirmDays: 30,
  /** C52 (f): a denied client may ask again after 30 days. */
  cooldownDays: 30,
};

/** The most a client's reason, or an answerer's reason for a denial, may say — the CHECKs' 1000. */
export const SEALED_REASON_MAX = 1000;

/**
 * An approval hands secrets to the client, so it asks a factor this recent
 * (minutes) — the authenticator code typed into its dialog, CP4's "always
 * step up" (`showLoginToClient`'s rule). A denial asks none beyond the ✦
 * window every `credential:unseal` check applies (C61 (b)).
 */
export const SEALED_APPROVE_STEP_UP_MINUTES = 1;

/**
 * The advisory lock one client's asks are decided under — the guard trigger
 * takes the same key (`'sealed_open_request:' || tenant_id || ':' ||
 * client_id`), so the broker's typed refusal and the database's belt judge
 * one ask at a time per client.
 */
export const sealedAskLockKey = (tenantId: string, clientId: string): string =>
  `sealed_open_request:${tenantId}:${clientId}`;

/**
 * How far back an UNSCHEDULED ask can still matter: the longest wait (60
 * days, `VAULT_SEALED_WAIT_DAYS_RANGE.max`) plus the 30 days a confirmation
 * may take, and a day to spare. An older one has lapsed for good; the job
 * and the `/vault` banner leave it out (both reviews' low: without the
 * bound every lapsed ask ever made was re-read, and row-locked, on every
 * run, and could crowd a live one off the banner).
 */
export const SEALED_UNSCHEDULED_HORIZON_DAYS = 60 + 30 + 1;
