/**
 * A request's body as text, read against `maxBytes` — or `null` when it is
 * larger. A declared `Content-Length` over the cap is refused unread; a body
 * that lies about its length (or declares none) is read only until it passes
 * the cap, then cancelled. Shared by the vault's JSON routes
 * (`src/app/api/vault/respond.ts`) and Amazon SES's feedback webhook
 * (`src/mailer/feedback-handler.ts`).
 */
export async function readCappedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
