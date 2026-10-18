"use client";

import type { Editor } from "@tiptap/core";
import { isInTable, selectedRect } from "@tiptap/pm/tables";
import { useEditorState } from "@tiptap/react";
import { ChevronDownIcon, TableIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TABLE_MAX_COLUMNS, TABLE_MAX_ROWS } from "@/lib/rich-text/table-bounds";

import { cellDepth } from "./paste-formatting";

type TableAction =
  | "insert"
  | "addRowAbove"
  | "addRowBelow"
  | "addColumnLeft"
  | "addColumnRight"
  | "deleteRow"
  | "deleteColumn"
  | "deleteTable";

const RUN: Readonly<Record<TableAction, (editor: Editor) => boolean>> = {
  insert: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  addRowAbove: (e) => e.chain().focus().addRowBefore().run(),
  addRowBelow: (e) => e.chain().focus().addRowAfter().run(),
  addColumnLeft: (e) => e.chain().focus().addColumnBefore().run(),
  addColumnRight: (e) => e.chain().focus().addColumnAfter().run(),
  deleteRow: (e) => e.chain().focus().deleteRow().run(),
  deleteColumn: (e) => e.chain().focus().deleteColumn().run(),
  deleteTable: (e) => e.chain().focus().deleteTable().run(),
};

/**
 * Where the caret is, as the menu needs it: in a table or not, and — from
 * the table's own map — whether the selection covers every row or every
 * column (the delete would leave nothing; `can()` does not know, since
 * prosemirror-tables checks that only when dispatching: the code review's
 * LOW-5) and whether the table is at its bounds (one more would be refused
 * on save: LOW-6).
 */
function tableShape(editor: Editor) {
  const { state } = editor;
  if (!isInTable(state)) {
    // A selection from a cell to past the table (Shift+click below it) has
    // its head outside: inserting there would nest a table in the start
    // cell, so "Insert a table" is offered disabled (the re-check's LOW-C).
    const straddles = cellDepth(state.selection.$from) >= 0 || cellDepth(state.selection.$to) >= 0;
    return { inTable: false, straddles, allRows: false, allColumns: false, fullWidth: false, fullHeight: false };
  }
  const rect = selectedRect(state);
  return {
    inTable: true,
    straddles: false,
    allRows: rect.top === 0 && rect.bottom === rect.map.height,
    allColumns: rect.left === 0 && rect.right === rect.map.width,
    fullWidth: rect.map.width >= TABLE_MAX_COLUMNS,
    fullHeight: rect.map.height >= TABLE_MAX_ROWS,
  };
}

/**
 * THE TABLE MENU (slice 132, founder decision C109 (b) — "simple controls"):
 * one button beside the formatting toolbar. Outside a table it offers
 * "Insert a table" (three by three, a header row); inside one, adding a row
 * or a column on either side and deleting the row, the column or the whole
 * table. Tab moves between cells (and adds a row from the last); nothing
 * here merges cells, colours them or sets a width.
 *
 * Never "Insert a table" INSIDE a table: a cell holds any block, so the
 * editor would nest one, and the normaliser refuses a table in a table.
 * A row or column the table cannot lose (its last) is offered disabled,
 * and so is adding one at the bounds (`tableShape`). Tab from the last cell
 * still adds a row past 500 — the extension's own key; the save then says
 * TABLE_TOO_LARGE, recorded in the design.
 *
 * The action runs AFTER the menu has closed (`onCloseAutoFocus`, its focus
 * return prevented) — the contract editor's fill-in menu learned that
 * focusing the editor while the menu still held focus fought Radix (CI run
 * 38091780925). Non-modal, so nothing else is locked while it is open.
 */
export function TableMenu({ editor, testId }: { editor: Editor | null; testId: string }) {
  const t = useTranslations("richText.table");
  const state = useEditorState({ editor, selector: ({ editor: e }) => (e ? tableShape(e) : null) });
  /** The action picked in the menu, run once the menu has closed. */
  const pickedRef = useRef<TableAction | null>(null);
  /** The menu closed by a press elsewhere: that press keeps its focus. */
  const outsideRef = useRef(false);
  const inTable = state?.inTable ?? false;

  const item = (action: TableAction, disabled = false, destructive = false) => (
    <DropdownMenuItem
      key={action}
      data-testid={`${testId}-${action}`}
      disabled={disabled}
      variant={destructive ? "destructive" : "default"}
      onSelect={() => {
        pickedRef.current = action;
      }}
    >
      {t(action)}
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        // A fresh opening forgets a pick from an earlier one whose close
        // never completed (reopened during its exit animation).
        if (open) {
          pickedRef.current = null;
          outsideRef.current = false;
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" disabled={!editor} data-testid={testId}>
          <TableIcon aria-hidden="true" />
          {t("menu")}
          <ChevronDownIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        onInteractOutside={() => {
          outsideRef.current = true;
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const action = pickedRef.current;
          const outside = outsideRef.current;
          pickedRef.current = null;
          outsideRef.current = false;
          if (!editor) return;
          if (action) RUN[action](editor);
          else if (!outside) editor.commands.focus();
        }}
      >
        {inTable ? (
          <>
            {item("addRowAbove", state?.fullHeight ?? true)}
            {item("addRowBelow", state?.fullHeight ?? true)}
            {item("addColumnLeft", state?.fullWidth ?? true)}
            {item("addColumnRight", state?.fullWidth ?? true)}
            <DropdownMenuSeparator />
            {item("deleteRow", state?.allRows ?? true, true)}
            {item("deleteColumn", state?.allColumns ?? true, true)}
            {item("deleteTable", false, true)}
          </>
        ) : (
          item("insert", state?.straddles ?? false)
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
