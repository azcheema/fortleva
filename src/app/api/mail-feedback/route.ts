import { mailFeedbackConfig } from "@/config";
import { recordMailFeedback } from "@/jobs/mail-feedback";
import { confirmSubscription, handleMailFeedback } from "@/mailer/feedback-handler";
import { loadSnsSigningKey } from "@/mailer/sns-cert";

/**
 * AMAZON SES'S BOUNCES AND COMPLAINTS (Phase 5 slice 103, founder decision
 * C71) — the HTTPS endpoint SNS delivers our feedback topic to. Public by an
 * exact-path exemption (`src/proxy.ts`): SNS carries no session, and what
 * makes a message ours is its signature AND its topic, checked in
 * `src/mailer/feedback-handler.ts` before anything is written. RUNBOOK §9 has
 * the AWS side (the topic, its subscription to this address, the dead-letter
 * queue, the configuration set).
 */
export async function POST(request: Request): Promise<Response> {
  return handleMailFeedback(request, {
    config: mailFeedbackConfig,
    loadKey: (certUrl, snsHost) => loadSnsSigningKey(certUrl, snsHost),
    confirm: (subscribeUrl) => confirmSubscription(subscribeUrl),
    record: recordMailFeedback,
  });
}
