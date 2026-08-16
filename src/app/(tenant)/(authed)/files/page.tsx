import { withTenant } from "@/db";
import { isAuthorized } from "@/authz/authorize";
import { listDocuments } from "@/documents/service";
import { requireTenantContext } from "@/members/tenant-context";

import { deleteDocumentAction, downloadAction } from "./actions";
import { UploadForm } from "./upload-form";

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

/** The two-token visibility badge (UI.md) — INTERNAL is the default. */
const VISIBILITY_LABEL = {
  INTERNAL: { text: "Private to team", className: "bg-neutral-100 text-neutral-700" },
  CLIENT_VISIBLE: { text: "Client can see", className: "bg-blue-50 text-blue-700" },
} as const;

export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { membership, actor } = await requireTenantContext();
  const { error } = await searchParams;
  const ctx = { tenantId: membership.tenantId, actor };

  const [documents, caps] = await Promise.all([
    listDocuments(ctx),
    withTenant(membership.tenantId, { type: "member", id: membership.memberId }, async (tx) => {
      const [canUpload, canDelete] = await Promise.all([
        isAuthorized(tx, actor, "document:upload"),
        isAuthorized(tx, actor, "document:delete"),
      ]);
      return { canUpload, canDelete };
    }),
  ]);

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">{membership.tenantName} — files</h1>

      {error ? (
        <p className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {documents.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">No files yet.</p>
      ) : (
        <ul className="mt-6 flex flex-col gap-2">
          {documents.map((d) => {
            const badge = VISIBILITY_LABEL[d.visibility];
            return (
              <li key={d.id} className="rounded border border-neutral-200 px-4 py-3">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="truncate font-medium">{d.name}</span>
                  <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${badge.className}`}>
                    {badge.text}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-4 text-sm text-neutral-600">
                  <span>{formatBytes(d.sizeBytes)}</span>
                  <span>
                    {d.versionCount} {d.versionCount === 1 ? "version" : "versions"}
                  </span>
                  <span className="text-neutral-400">
                    {d.updatedAt.toISOString().slice(0, 10)}
                  </span>
                  <form action={downloadAction} className="ml-auto">
                    <input type="hidden" name="documentId" value={d.id} />
                    <button type="submit" className="hover:underline">
                      Download
                    </button>
                  </form>
                  {caps.canDelete ? (
                    <form action={deleteDocumentAction}>
                      <input type="hidden" name="documentId" value={d.id} />
                      <button type="submit" className="text-red-600 hover:underline">
                        Delete
                      </button>
                    </form>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {caps.canUpload ? (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Upload a file</h2>
          <UploadForm />
        </section>
      ) : null}
    </main>
  );
}
