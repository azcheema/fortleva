"use client";

import { DownloadIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { saveTextFile } from "@/lib/save-file";

import { exportLoginsAction } from "./export-actions";

export type ExportOption = { readonly value: string; readonly label: string };

/**
 * EXPORT LOGINS (Phase 3V slice 95; founder decision C63) — `/vault`'s
 * "Export…", for a member who may export. A dialog, because exporting
 * ALWAYS asks for the member's authenticator code (AUTHZ.md §7.5, CP4) and
 * because the member should read what the file is first: every password in
 * it in plain text, a mail to everyone who can export, and a count against
 * them if they later leave (C63 (d)).
 *
 * The action is called DIRECTLY in a transition — not through
 * `useActionState` — so the file's text lives in this closure only, from
 * the answer to the save, and never in React state. Its form lives INSIDE
 * the content, which Radix unmounts on close, so every opening starts
 * blank: no typed code, no earlier refusal.
 */
export function ExportDialog({
  options,
  historyHref,
}: {
  options: readonly ExportOption[];
  /** The exports page, for a member who may read it (a tenant-wide scope) — null hides the link. */
  historyHref: string | null;
}) {
  const t = useTranslations("vault.export");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="vault-export-open">
          <DownloadIcon />
          {t("open")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md" data-testid="vault-export-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <ExportForm options={options} historyHref={historyHref} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ExportForm({
  options,
  historyHref,
  onDone,
}: {
  options: readonly ExportOption[];
  historyHref: string | null;
  onDone: () => void;
}) {
  const t = useTranslations("vault.export");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [refusal, setRefusal] = useState<string | null>(null);

  return (
    <form
      onSubmit={(e) => {
        // NOT a `<form action>`: React 19 resets one after EVERY action, a
        // refusal included (AGENTS.md's standing trap).
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setRefusal(null);
        startTransition(async () => {
          const r = await exportLoginsAction(fd);
          if (!r.ok) {
            setRefusal(r.message);
            return;
          }
          saveTextFile(r.value.csv, r.value.filename, "text/csv;charset=utf-8");
          toast.success(t("done", { count: r.value.count }));
          // What the member must know about THIS file, for longer than a toast's usual few seconds.
          if (r.value.formulaValues > 0) toast.warning(t("formulaWarning"), { duration: 20_000 });
          if (r.value.tooLong.length > 0) {
            // The first five by name; an ellipsis says there were more.
            const names = [...r.value.tooLong.slice(0, 5), ...(r.value.tooLong.length > 5 ? ["…"] : [])].join(", ");
            toast.warning(t("tooLongWarning", { names }), { duration: 20_000 });
          }
          onDone();
          // The exports page and anything else the server draws from the trail.
          router.refresh();
        });
      }}
      className="flex flex-col gap-3"
      data-testid="vault-export-form"
    >
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
        <li>{t("pointPlain")}</li>
        <li>{t("pointMail")}</li>
        <li>{t("pointLeaving")}</li>
      </ul>
      <Field label={t("which")} htmlFor="vault-export-which">
        <NativeSelect id="vault-export-which" name="which" className="w-full" defaultValue="" disabled={pending}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={t("code")} htmlFor="vault-export-code" hint={t("codeHint")} required>
        <Input
          id="vault-export-code"
          name="code"
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={32}
          className="font-mono"
          disabled={pending}
        />
      </Field>
      {refusal !== null ? <FormMessage state={{ ok: false, message: refusal }} /> : null}
      {historyHref !== null ? (
        <p className="text-xs text-muted-foreground">
          <Link
            href={historyHref}
            className="rounded-sm text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t("history")}
          </Link>
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? t("submitting") : t("submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
