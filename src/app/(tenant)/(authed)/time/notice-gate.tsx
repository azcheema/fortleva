"use client";

import { ShieldCheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";

import { acknowledgeNoticeAction } from "./actions";

/**
 * The staff notice (SECURITY.md §9.7.5): shown before the first timer or
 * clock-in and whenever a new version is published; the member reads it
 * and acknowledges (notice, not consent). The body is markdown-light
 * from the seed or the tenant's own text: headings, bullets, bold —
 * rendered by a tiny structural renderer, never as HTML.
 */
export function NoticeGate({
  notice,
}: {
  notice: { id: string; version: number; title: string; body: string };
}) {
  const t = useTranslations("time.notice");
  const router = useRouter();
  const [pending, start] = useTransition();

  const acknowledge = () =>
    start(async () => {
      const r = await acknowledgeNoticeAction(notice.id).catch(() => ({ ok: false as const, message: t("failed") }));
      if (!r.ok) toast.error(r.message);
      else {
        toast.success(r.message);
        router.refresh();
      }
    });

  return (
    <SectionCard
      title={notice.title}
      description={t("description", { version: notice.version })}
      actions={
        <Button type="button" size="sm" onClick={acknowledge} disabled={pending} data-testid="notice-acknowledge">
          <ShieldCheckIcon aria-hidden="true" />
          {t("acknowledge")}
        </Button>
      }
    >
      <NoticeBody body={notice.body} />
      <p className="mt-4 text-xs text-muted-foreground">{t("footnote")}</p>
    </SectionCard>
  );
}

/** `## `, `- ` and `**bold**` only — the shape the seed uses. */
export function NoticeBody({ body }: { body: string }) {
  const blocks: { kind: "h" | "li" | "p"; text: string }[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("## ")) blocks.push({ kind: "h", text: line.slice(3) });
    else if (line.startsWith("- ")) blocks.push({ kind: "li", text: line.slice(2) });
    else blocks.push({ kind: "p", text: line });
  }
  const inline = (text: string): React.ReactNode[] =>
    text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        <span key={i}>{part}</span>
      ),
    );
  const out: React.ReactNode[] = [];
  let list: React.ReactNode[] = [];
  const flush = () => {
    if (list.length) {
      out.push(
        <ul key={`ul-${out.length}`} className="my-2 list-disc space-y-1 pl-5 text-sm">
          {list}
        </ul>,
      );
      list = [];
    }
  };
  blocks.forEach((b, i) => {
    if (b.kind === "li") {
      list.push(<li key={i}>{inline(b.text)}</li>);
      return;
    }
    flush();
    if (b.kind === "h") out.push(<h3 key={i} className="mt-4 text-sm font-semibold first:mt-0">{inline(b.text)}</h3>);
    else out.push(<p key={i} className="my-2 text-sm text-muted-foreground">{inline(b.text)}</p>);
  });
  flush();
  return <div className="max-w-prose">{out}</div>;
}
