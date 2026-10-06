/**
 * Hand the browser a file made in the page — the vault export's CSV (slice
 * 95) — through a temporary object URL and a clicked `<a download>`. The
 * URL is revoked a few seconds after the click: at once can cancel the
 * download in Firefox and Safari, and the file holds secrets, so it is not left
 * addressable for the life of the page. Client-only.
 */
export function saveTextFile(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}
