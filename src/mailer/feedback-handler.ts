import type { MailFeedbackConfig } from "@/config";
import { readCappedText } from "@/lib/capped-body";

import type { CertAnswer } from "./sns-cert";
import { isPinnedSubscribeUrl, readSesFeedback, readSnsEnvelope, verifySnsSignature, type SesFeedback } from "./sns";

/**
 * `POST /api/mail-feedback` — AMAZON SES'S BOUNCES AND COMPLAINTS, DELIVERED BY
 * SNS (Phase 5 slice 103, founder decision C71; ARCHITECTURE.md ARC-09). The
 * route (`src/app/api/mail-feedback/route.ts`) wires the real dependencies;
 * this is the order of checks, with each answer chosen for what SNS does with
 * it — SNS retries a 5xx (and then hands the message to the subscription's
 * dead-letter queue), and treats any other answer as final:
 *
 * | what | answer |
 * |---|---|
 * | no topic configured | 404 — nothing here to deliver to |
 * | body over 300 KB | 413 (an SNS message is at most 256 KB) |
 * | not an SNS envelope, or the `x-amz-sns-message-type` header disagrees | 400 |
 * | another topic | 403 — **before anything is fetched** (`sns.ts` says why the topic) |
 * | a certificate URL off AWS's pinned host and path, or a bad certificate | 403 |
 * | AWS's certificate host unreachable | 503 — SNS tries again |
 * | a signature that does not verify (version 2 only) | 403 |
 * | a signed Timestamp over three hours old, or from the future | 403 — SNS never retries that late |
 * | SubscriptionConfirmation | the pinned SubscribeURL fetched: 200, or 503 to be sent again |
 * | UnsubscribeConfirmation | logged, 200 — never re-subscribed by itself |
 * | Notification that is not a hard bounce or a spam report about mail we sent to that address | 200, nothing written (a refused bounce or complaint is logged as a reason) |
 * | Notification that is | the addresses blocked (`recordMailFeedback`): 200, or 500 when the write failed |
 *
 * Every answer is empty and `no-store`. Nothing logged names an address.
 *
 * **No rate limiter**: a stranger is turned away by the topic check before any
 * work, and what passes it costs one certificate fetch from a bounded budget
 * and one signature check (`sns-cert.ts`). A secret in the subscription URL
 * would turn even a holder of the topic's ARN away before the parse — owed,
 * recorded (PLAN §0).
 */

/** An SNS message is at most 256 KB; the envelope adds a little. */
export const FEEDBACK_BODY_MAX = 300 * 1024;
/** SNS retries an HTTPS delivery for at most an hour; three is the margin. */
const MAX_AGE_MS = 3 * 60 * 60_000;
const MAX_SKEW_MS = 15 * 60_000;

export type FeedbackDeps = {
  readonly config: MailFeedbackConfig | null;
  /** The clock (tests). */
  readonly now?: () => Date;
  readonly loadKey: (certUrl: string, snsHost: string) => Promise<CertAnswer>;
  /** GET the (already pinned) SubscribeURL; true when AWS answered 2xx. */
  readonly confirm: (subscribeUrl: string) => Promise<boolean>;
  readonly record: (feedback: SesFeedback) => Promise<number>;
};

const empty = (status: number): Response =>
  new Response(null, { status, headers: { "Cache-Control": "no-store" } });

export async function handleMailFeedback(request: Request, deps: FeedbackDeps): Promise<Response> {
  const { config } = deps;
  if (config === null) return empty(404);

  const text = await readCappedText(request, FEEDBACK_BODY_MAX);
  if (text === null) return empty(413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return empty(400);
  }
  const envelope = readSnsEnvelope(body);
  if (envelope === null || request.headers.get("x-amz-sns-message-type") !== envelope.Type) return empty(400);

  if (envelope.TopicArn !== config.topicArn) return empty(403);

  const key = await deps.loadKey(envelope.SigningCertURL, config.snsHost);
  if (key === "unavailable") return empty(503);
  if (key === "refused" || !verifySnsSignature(envelope, key)) return empty(403);

  // FRESH, by the SIGNED timestamp (the security review's low): SNS stops
  // retrying an HTTPS delivery after an hour, so nothing genuine arrives three
  // hours late — and a captured message replayed after support lifted a block
  // would otherwise block the address again. Nor from the future, past a
  // clock's slack.
  const sentAt = Date.parse(envelope.Timestamp);
  const now = (deps.now ?? (() => new Date()))().getTime();
  if (!Number.isFinite(sentAt) || now - sentAt > MAX_AGE_MS || sentAt - now > MAX_SKEW_MS) return empty(403);

  switch (envelope.Type) {
    case "SubscriptionConfirmation": {
      if (!isPinnedSubscribeUrl(envelope.SubscribeURL ?? "", config.snsHost, config.topicArn)) return empty(403);
      if (!(await deps.confirm(envelope.SubscribeURL!))) return empty(503);
      console.info("[mail-feedback] subscription to the feedback topic confirmed");
      return empty(200);
    }
    case "UnsubscribeConfirmation":
      // Somebody removed the subscription in AWS. Not re-subscribed from here:
      // that is a decision for whoever removed it (RUNBOOK §9).
      console.warn("[mail-feedback] the feedback topic's subscription was removed — bounces are no longer recorded");
      return empty(200);
    case "Notification": {
      const { feedback, note } = readSesFeedback(envelope.Message, config.accountId);
      // Reasons and counts only — never an address.
      if (note !== null) console.warn(`[mail-feedback] ${note}`);
      if (feedback === null) return empty(200);
      try {
        const added = await deps.record(feedback);
        console.info(`[mail-feedback] ${feedback.reason}: ${added} address(es) newly blocked`);
        return empty(200);
      } catch (e) {
        // The NAME and code only — a Prisma message prints its arguments.
        const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
        console.error(`[mail-feedback] could not record feedback: ${e instanceof Error ? e.name : typeof e}${code}`);
        return empty(500);
      }
    }
  }
}

/** GET a pinned SubscribeURL, five seconds, no redirects. */
export async function confirmSubscription(subscribeUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(subscribeUrl, { redirect: "error", signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}
