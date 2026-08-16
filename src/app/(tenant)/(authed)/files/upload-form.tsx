"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { commitUploadAction, presignUploadAction } from "./actions";

/**
 * Upload = three hops, none of which stream bytes through the app:
 * 1) presign (server action → PENDING FileObject + signed PUT URL),
 * 2) PUT the bytes straight to storage with the signed headers,
 * 3) commit (server action → HEAD-verify → COMMITTED + Document).
 */

const sha256Hex = async (file: File): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; step: string }
  | { kind: "error"; message: string }
  | { kind: "done"; name: string };

export function UploadForm() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) return;

    setPhase({ kind: "busy", step: "Preparing…" });
    const sha256 = await sha256Hex(file);
    const presign = await presignUploadAction({
      name: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      sha256,
    });
    if (!presign.ok) return setPhase({ kind: "error", message: presign.message });

    setPhase({ kind: "busy", step: "Uploading…" });
    // Content-Length is a forbidden request header for fetch — the browser
    // sets it from the body; only Content-Type is sent explicitly.
    const put = await fetch(presign.value.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": presign.value.contentType },
      body: file,
    }).catch(() => null);
    if (!put || !put.ok) {
      return setPhase({ kind: "error", message: `Upload failed (${put?.status ?? "network"}).` });
    }

    setPhase({ kind: "busy", step: "Finishing…" });
    const commit = await commitUploadAction(presign.value.fileObjectId);
    if (!commit.ok) return setPhase({ kind: "error", message: commit.message });

    setPhase({ kind: "done", name: file.name });
    if (inputRef.current) inputRef.current.value = "";
    startTransition(() => router.refresh());
  };

  const busy = phase.kind === "busy";

  return (
    <form onSubmit={onSubmit} className="mt-3 flex max-w-md flex-col gap-3">
      <input
        ref={inputRef}
        type="file"
        name="file"
        required
        disabled={busy}
        className="rounded border border-neutral-300 px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-neutral-100 file:px-3 file:py-1"
      />
      <label className="flex flex-col gap-1 text-sm">
        <span>Visibility</span>
        <select
          name="visibility"
          disabled
          defaultValue="INTERNAL"
          className="rounded border border-neutral-300 px-3 py-2 disabled:bg-neutral-100 disabled:text-neutral-500"
        >
          <option value="INTERNAL">Private to team</option>
          <option value="CLIENT_VISIBLE">Client can see</option>
        </select>
        <span className="text-xs text-neutral-500">
          Files are private to your team. Sharing with a client arrives with Clients (Phase 2).
        </span>
      </label>
      <button
        type="submit"
        disabled={busy}
        className="self-start rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
      >
        {busy ? phase.step : "Upload"}
      </button>
      {phase.kind === "error" ? <p className="text-sm text-red-600">{phase.message}</p> : null}
      {phase.kind === "done" ? (
        <p className="text-sm text-green-700">Uploaded {phase.name}</p>
      ) : null}
    </form>
  );
}
