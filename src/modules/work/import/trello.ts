import { z } from "zod";

import { cleanCell } from "./csv-parse";
import { isImportDay, isTrelloLink } from "./rules";

/**
 * READING A TRELLO BOARD EXPORT (Phase 6 slice 121; founder decision C97
 * (a); design §2.2). Trello's free plan exports a board only as its own
 * JSON (Board menu → Print, export and share → Export as JSON), which
 * carries lists, cards, labels, checklists and members — but no member's
 * email, so people are matched by name (design R4). Pure and browser-safe.
 *
 * Only what the import uses is read; everything else in the export (actions,
 * custom fields, Power-Up data, attachments) is ignored without being
 * validated, so an export from a newer Trello still reads.
 */

const id = z.string().min(1).max(200);
const pos = z.union([z.number(), z.string()]).optional();

const boardSchema = z.object({
  lists: z.array(z.object({ id, name: z.string(), closed: z.boolean().optional(), pos })),
  cards: z.array(
    z.object({
      id,
      name: z.string(),
      desc: z.string().optional(),
      closed: z.boolean().optional(),
      idList: z.string(),
      idMembers: z.array(z.string()).optional(),
      idLabels: z.array(z.string()).optional(),
      due: z.string().nullable().optional(),
      shortUrl: z.string().optional(),
      pos,
    }),
  ),
  labels: z.array(z.object({ id, name: z.string().nullable().optional() })).optional(),
  members: z.array(z.object({ id, fullName: z.string().nullable().optional(), username: z.string().optional() })).optional(),
  checklists: z
    .array(
      z.object({
        id,
        idCard: z.string(),
        name: z.string().nullable().optional(),
        pos,
        checkItems: z
          .array(z.object({ name: z.string(), state: z.string().optional(), pos }))
          .optional(),
      }),
    )
    .optional(),
});

export type TrelloCard = {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly listId: string;
  /** The due INSTANT's calendar day in the workspace's zone, `YYYY-MM-DD`, or null. */
  readonly due: string | null;
  /** The card's FIRST member (a task has one assignee — design R4). */
  readonly memberId: string | null;
  readonly labels: readonly string[];
  readonly checklists: readonly { readonly name: string | null; readonly items: readonly { readonly text: string; readonly done: boolean }[] }[];
  /** `https://trello.com/c/…` — or null when the export's value is anything else. */
  readonly link: string | null;
};

export type TrelloBoard = {
  readonly lists: readonly { readonly id: string; readonly name: string }[];
  readonly members: readonly { readonly id: string; readonly name: string }[];
  readonly cards: readonly TrelloCard[];
  /** Archived cards, and cards in archived lists — left out and counted (design R3). */
  readonly archivedCards: number;
};

const order = (p: number | string | undefined): number => {
  const n = typeof p === "number" ? p : Number(p);
  return Number.isFinite(n) ? n : 0;
};

/** Trello names its default checklist "Checklist" (or "Checklista" in Swedish) — a heading that says nothing. */
const DEFAULT_CHECKLIST_NAMES = new Set(["checklist", "checklista"]);

/**
 * Trello stores a due date as an INSTANT (its picker defaults to midday,
 * local). The task's due date is a DAY, so the instant is read in the
 * workspace's zone — UTC would move a Swedish 00:30 to the day before.
 */
const dayOf = (due: string | null | undefined, timeZone: string): string | null => {
  if (!due) return null;
  const t = Date.parse(due);
  if (!Number.isFinite(t)) return null;
  // The PARTS, never a locale's whole format string; and only a day the
  // server takes (1970–2100) — one card due in 2202 must not refuse its
  // whole batch (the code review).
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(t);
  const part = (type: "year" | "month" | "day") => parts.find((p) => p.type === type)?.value ?? "";
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  return isImportDay(day) ? day : null;
};

/** The server's own rule (`isTrelloLink`): a link it would refuse is dropped here, never sent. */
const trelloLink = (value: string | undefined): string | null => (value && isTrelloLink(value) ? value : null);

/** `null` when the JSON is not a Trello board export. */
export function readTrelloBoard(json: unknown, timeZone: string): TrelloBoard | null {
  const parsed = boardSchema.safeParse(json);
  if (!parsed.success) return null;
  const board = parsed.data;
  const openLists = board.lists
    .filter((l) => !l.closed)
    .sort((a, b) => order(a.pos) - order(b.pos))
    .map((l) => ({ id: l.id, name: cleanCell(l.name).trim() }));
  const listOrder = new Map(openLists.map((l, i) => [l.id, i]));
  const labelName = new Map(
    (board.labels ?? [])
      .map((l) => [l.id, cleanCell(l.name ?? "").trim()] as const)
      .filter(([, name]) => name !== ""),
  );
  const checklistsByCard = new Map<string, typeof board.checklists>();
  for (const c of board.checklists ?? []) {
    const list = checklistsByCard.get(c.idCard) ?? [];
    list.push(c);
    checklistsByCard.set(c.idCard, list);
  }
  let archivedCards = 0;
  const open = board.cards.filter((c) => {
    const live = !c.closed && listOrder.has(c.idList);
    if (!live) archivedCards++;
    return live;
  });
  open.sort((a, b) => listOrder.get(a.idList)! - listOrder.get(b.idList)! || order(a.pos) - order(b.pos));
  const cards: TrelloCard[] = open.map((c) => {
    const seen = new Set<string>();
    const labels: string[] = [];
    for (const lid of c.idLabels ?? []) {
      const name = labelName.get(lid);
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        labels.push(name);
      }
    }
    const checklists = (checklistsByCard.get(c.id) ?? [])
      .slice()
      .sort((a, b) => order(a.pos) - order(b.pos))
      .map((cl) => {
        const name = cleanCell(cl.name ?? "").trim();
        return {
          name: name === "" || DEFAULT_CHECKLIST_NAMES.has(name.toLowerCase()) ? null : name,
          items: (cl.checkItems ?? [])
            .slice()
            .sort((a, b) => order(a.pos) - order(b.pos))
            .map((i) => ({ text: cleanCell(i.name).trim(), done: i.state === "complete" }))
            .filter((i) => i.text !== ""),
        };
      })
      .filter((cl) => cl.items.length > 0);
    return {
      id: c.id,
      name: cleanCell(c.name).trim(),
      desc: cleanCell(c.desc ?? ""),
      listId: c.idList,
      due: dayOf(c.due, timeZone),
      memberId: c.idMembers?.[0] ?? null,
      labels,
      checklists,
      link: trelloLink(c.shortUrl),
    };
  });
  const members = (board.members ?? []).map((m) => ({
    id: m.id,
    name: cleanCell(m.fullName?.trim() || m.username || "").trim(),
  }));
  return { lists: openLists, members, cards, archivedCards };
}
