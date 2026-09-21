"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";

import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormResult } from "@/lib/server-actions";
// THE LEAF, NEVER THE BARREL. `@/modules/work` re-exports the brokered
// writer, whose graph reaches `withTenant` → the Prisma client → `pg`
// → Node's `util/types`, and this is a browser module: the build fails
// outright. `request-limits.ts` imports nothing at all, and its header
// records the measurement.
import { REQUEST_BODY_MAX, REQUEST_TITLE_MAX } from "@/modules/work/request-limits";
import type { PortalProjectOption } from "@/projects/portal";

import { submitRequestAction } from "./actions";

/**
 * THE REQUEST FORM — three fields, and every one of them is CONTROLLED.
 *
 * That is not a preference, it is AGENTS.md's standing React 19 trap:
 * **a `<form action>` is reset at the start of every action**, so an
 * uncontrolled `<select>` snaps back to its first option the moment the
 * submit begins, and an uncontrolled `<input>` empties. On a form that
 * can FAIL — this one fails on a rate limit, on a title that is too
 * long, and on any refusal the plane collapses into one message — that
 * would mean the client watches everything they typed disappear and
 * reads "something went wrong" over an empty form. Controlled state
 * survives the reset, so a refusal leaves the words in place and the
 * client can fix one and send again.
 *
 * NO TOAST, AND NO SUCCESS BRANCH AT ALL. Sonner is mounted on the
 * member app's shell, not on the portal's, and the portal's chrome is
 * deliberately the short list UI.md §11 gives it. The confirmation is
 * the thing itself: the action REDIRECTS to `/portal` on success (see
 * `actions.ts` for why that is a server redirect and not a
 * `router.push` after a `refresh`), where the new request is the top row
 * of the "Requested" group. So this component only ever renders a
 * pending state or a failure, which is why nothing here resets the
 * fields: on success it is gone.
 *
 * THE PROJECT PICKER IS A NATIVE `<select>`, not the Radix one. It needs
 * no client JS to be usable, it is keyboard-native, and the portal is
 * the surface where the fewest assumptions about the reader's browser
 * should be made. With exactly one project it is still rendered rather
 * than hidden: a client filing a request should be able to see which
 * project they are filing it against.
 */
export function RequestForm({ projects }: { projects: readonly PortalProjectOption[] }) {
  const t = useTranslations("portal.requests");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(
    submitRequestAction,
    null,
  );
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  return (
    <form action={action} className="flex flex-col gap-4">
      <Field label={t("project")} htmlFor="request-project">
        <NativeSelect
          id="request-project"
          name="projectId"
          required
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          disabled={pending}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={t("titleLabel")} htmlFor="request-title" hint={t("titleHint")}>
        <Input
          id="request-title"
          name="title"
          required
          maxLength={REQUEST_TITLE_MAX}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("titlePlaceholder")}
          disabled={pending}
        />
      </Field>
      <Field label={t("body")} htmlFor="request-body" hint={t("bodyHint")}>
        <Textarea
          id="request-body"
          name="body"
          rows={5}
          maxLength={REQUEST_BODY_MAX}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t("bodyPlaceholder")}
          disabled={pending}
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t("submitting") : t("submit")}
        </Button>
      </div>
      {state && !state.ok ? <FormMessage state={state} /> : null}
    </form>
  );
}
