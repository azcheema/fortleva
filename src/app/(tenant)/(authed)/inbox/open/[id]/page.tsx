import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { isUuid } from "@/db/context";
import { requireTenantContext } from "@/members/tenant-context";

import { OpenNotification } from "./open-notification";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("inbox") };
}

/**
 * `/inbox/open/<id>` — where a tap on a phone or browser notification lands
 * (Phase 5 slice 106; founder decision C74 (a)). The push carried only the id.
 *
 * THE GET CHANGES NOTHING (the reply address's confirm page's rule): the island
 * calls `openNotificationAction`, a server action, which finds the
 * notification among the signed-in person's own, marks it read and answers
 * where to go. Not an id → straight to the inbox.
 */
export default async function OpenNotificationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireTenantContext();
  if (!isUuid(id)) redirect("/inbox");
  return <OpenNotification id={id} />;
}
