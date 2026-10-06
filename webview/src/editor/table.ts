/**
 * GFM table editing helpers (Phase 7): context of the selection, column alignment and keys.
 * Structural commands (add/delete row/column) come from @tiptap/extension-table.
 */
import { Extension, type Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';

export type Align = 'left' | 'center' | 'right' | null;

/**
 * Insert a block (table, rule) after the current paragraph instead of splitting it when the
 * cursor sits inside text; an empty paragraph is replaced.
 */
export function insertBlockAfterText(editor: Editor, insert: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>): boolean {
  const { selection } = editor.state;
  let chain = editor.chain().focus();
  if (selection.empty && selection.$from.parent.isTextblock && selection.$from.parent.content.size > 0) {
    chain = chain.setTextSelection(selection.$from.end());
  }
  return insert(chain).run();
}

export function insertTable(editor: Editor): boolean {
  return insertBlockAfterText(editor, (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }));
}

export interface TableContext {
  tablePos: number;
  rowIndex: number;
  colIndex: number;
  rows: number;
  cols: number;
  align: Align;
}

export function tableContext(state: EditorState): TableContext | null {
  const { selection } = state;
  const $pos = selection instanceof CellSelection ? selection.$headCell : selection.$from;
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name !== 'table') continue;
    // Inside a cell or (CellSelection) just before it: depth + 1 is the row in both cases.
    if ($pos.depth < depth + 1) return null;
    const rowIndex = $pos.index(depth);
    const colIndex = $pos.index(depth + 1);
    const header = node.firstChild;
    const cell = header?.maybeChild(colIndex);
    return {
      tablePos: $pos.before(depth),
      rowIndex,
      colIndex,
      rows: node.childCount,
      cols: header?.childCount ?? 0,
      align: ((cell?.attrs.align as Align | undefined) ?? null) || null,
    };
  }
  return null;
}

/** Set the alignment of the column containing the selection (written on the delimiter row). */
export function setColumnAlign(editor: Editor, align: Align): boolean {
  const context = tableContext(editor.state);
  if (!context) return false;
  const { state } = editor;
  const table = state.doc.nodeAt(context.tablePos);
  if (!table) return false;
  const tr = state.tr;
  table.forEach((row, rowOffset) => {
    let cellPos = context.tablePos + 1 + rowOffset + 1;
    row.forEach((cell, _offset, index) => {
      if (index === context.colIndex && (cell.attrs.align ?? null) !== align) {
        tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, align });
      }
      cellPos += cell.nodeSize;
    });
  });
  if (!tr.docChanged) return true;
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

/** Move the caret to the cell below (adding a row at the end of the table). */
function moveDown(editor: Editor): boolean {
  const context = tableContext(editor.state);
  if (!context) return false;
  if (context.rowIndex === context.rows - 1) {
    if (!editor.chain().addRowAfter().run()) return false;
  }
  const { state } = editor;
  const table = state.doc.nodeAt(context.tablePos);
  if (!table) return false;
  let pos = context.tablePos + 1;
  for (let r = 0; r <= context.rowIndex; r++) pos += table.child(r).nodeSize;
  const row = table.child(context.rowIndex + 1);
  pos += 1;
  for (let c = 0; c < Math.min(context.colIndex, row.childCount - 1); c++) pos += row.child(c).nodeSize;
  const cell = row.child(Math.min(context.colIndex, row.childCount - 1));
  editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos + 1 + cell.content.size)).scrollIntoView());
  return true;
}

/**
 * GFM table cells are single lines: Enter moves to the next row and line breaks are refused
 * (they cannot be written inside a table row).
 */
export const TableKeys = Extension.create({
  name: 'markliveTableKeys',
  priority: 200,
  addKeyboardShortcuts() {
    const inCell = () => tableContext(this.editor.state) !== null;
    return {
      Enter: () => (inCell() ? moveDown(this.editor) : false),
      'Shift-Enter': () => inCell(),
      'Mod-Enter': () => inCell(),
    };
  },
});
