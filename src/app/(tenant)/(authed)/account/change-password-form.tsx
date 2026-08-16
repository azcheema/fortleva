"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { authClient } from "@/auth/client";
import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ChangePasswordForm() {
  const t = useTranslations("account.password");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const { error } = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    });
    setBusy(false);
    if (error) {
      setMessage({ ok: false, message: error.message ?? t("failed") });
      return;
    }
    setCurrent("");
    setNext("");
    setMessage({ ok: true, message: t("changed") });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field label={t("current")} htmlFor="current-password">
        <Input
          id="current-password"
          type="password"
          required
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>
      <Field label={t("new")} htmlFor="new-password">
        <Input
          id="new-password"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </Field>
      <Button type="submit" disabled={busy} className="self-start">
        {busy ? t("submitting") : t("submit")}
      </Button>
      <FormMessage state={message} />
    </form>
  );
}
