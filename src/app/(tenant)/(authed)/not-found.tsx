import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** 404 (never 403) inside the member plane — UI.md §7.3. */
export default async function AuthedNotFound() {
  const t = await getTranslations("shell.notFound");
  return (
    <div className="mx-auto w-full max-w-md px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/home">{t("home")}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
