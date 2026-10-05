/**
 * Editing behaviour of the Live editor: shortcuts, Markdown input rules, Markdown clipboard,
 * Ctrl/Cmd+click on links, GFM table normalisation and the "active block" decoration used by
 * node views.
 */
import { Extension, InputRule, type Editor } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { markdownToSlice, sliceToMarkdown } from '../../../shared/markdown/clipboard';
import { EXTERNAL_META } from '../../../shared/sync/SyncClient';
import { ACTIVE_SPEC, wikilinkTarget } from './nodeviews';
import type { EditorServices } from './services';

export { markdownToSlice, sliceToMarkdown };

// ------------------------------------------------------------------ clipboard

function clipboardPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('liveMarkdownClipboard'),
    props: {
      clipboardTextSerializer: (slice: Slice, view: EditorView) => sliceToMarkdown(slice, view.state.schema),
      clipboardTextParser: (text: string, $context, _plain: boolean, view: EditorView) => {
        if ($context.parent.type.spec.code) return new Slice(Fragment.from(view.state.schema.text(text)), 0, 0);
        return markdownToSlice(text, view.state.schema);
      },
      handlePaste(view: EditorView, event: ClipboardEvent) {
        const data = event.clipboardData;
        if (!data || view.state.selection.$from.parent.type.spec.code) return false;
        // Text copied from VS Code's text editor carries syntax-highlighted HTML: use the Markdown.
        if (!data.types.includes('vscode-editor-data')) return false;
        const text = data.getData('text/plain');
        if (!text) return false;
        let mode: string | undefined;
        try {
          mode = (JSON.parse(data.getData('vscode-editor-data')) as { mode?: string }).mode;
        } catch {
          mode = undefined;
        }
        // Code copied from another language becomes a fenced block tagged with that language.
        if (mode && mode !== 'markdown' && mode !== 'plaintext') {
          const codeBlock = view.state.schema.nodes.codeBlock;
          if (!codeBlock) return false;
          const code = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
          const node = codeBlock.create({ language: mode }, code ? view.state.schema.text(code) : null);
          view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
          return true;
        }
        view.dispatch(view.state.tr.replaceSelection(markdownToSlice(text, view.state.schema)).scrollIntoView());
        return true;
      },
    },
  });
}

// ------------------------------------------------------------------ links

function linkAt(state: EditorState, pos: number): string | null {
  const node = state.doc.nodeAt(pos);
  const link = node?.marks.find((m) => m.type.name === 'link');
  if (link?.attrs.href) return String(link.attrs.href);
  if (node?.type.name === 'rawInline' && node.attrs.kind === 'wikilink') return wikilinkTarget(String(node.attrs.source));
  const $pos = state.doc.resolve(pos);
  const before = $pos.nodeBefore?.marks.find((m) => m.type.name === 'link');
  if (before?.attrs.href && $pos.nodeAfter?.marks.some((m) => m.eq(before))) return String(before.attrs.href);
  return null;
}

function linkClickPlugin(services: EditorServices): Plugin {
  return new Plugin({
    key: new PluginKey('liveMarkdownLinkClick'),
    props: {
      handleClick(view: EditorView, pos: number, event: MouseEvent) {
        if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return false;
        const href = linkAt(view.state, pos);
        if (!href) return false;
        event.preventDefault();
        services.openLink(href);
        return true;
      },
    },
  });
}

// ------------------------------------------------------------------ tables

/**
 * GFM tables have exactly one header row and one alignment per column: keep the first row as
 * header cells, the others as body cells, and copy the header alignment to the whole column.
 */
function normalizeTables(state: EditorState): Transaction | null {
  const { tableHeader, tableCell } = state.schema.nodes;
  if (!tableHeader || !tableCell) return null;
  const changes: Array<{ pos: number; type: typeof tableCell; attrs: Record<string, unknown> }> = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return !node.isTextblock;
    const align: Array<unknown> = [];
    node.forEach((row, rowOffset, rowIndex) => {
      row.forEach((cell, cellOffset, cellIndex) => {
        const cellPos = pos + 1 + rowOffset + 1 + cellOffset;
        const type = rowIndex === 0 ? tableHeader : tableCell;
        if (rowIndex === 0) align[cellIndex] = cell.attrs.align ?? null;
        const wanted = rowIndex === 0 ? (cell.attrs.align ?? null) : (align[cellIndex] ?? null);
        if (cell.type !== type || (cell.attrs.align ?? null) !== wanted) {
          changes.push({ pos: cellPos, type, attrs: { ...cell.attrs, align: wanted } });
        }
      });
    });
    return false;
  });
  if (changes.length === 0) return null;
  const tr = state.tr;
  for (const change of changes) tr.setNodeMarkup(change.pos, change.type, change.attrs);
  return tr;
}

function tablePlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('liveMarkdownTables'),
    appendTransaction(transactions, _old, state) {
      if (!transactions.some((tr) => tr.docChanged) || transactions.some((tr) => tr.getMeta(EXTERNAL_META))) return null;
      return normalizeTables(state);
    },
  });
}

// ------------------------------------------------------------------ active block

const ACTIVE_TYPES = new Set(['codeBlock']);

function activeBlockPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('liveMarkdownActiveBlock'),
    props: {
      decorations(state) {
        const { selection } = state;
        const { $from } = selection;
        const selected = (selection as { node?: PMNode }).node;
        if (selected && ACTIVE_TYPES.has(selected.type.name)) {
          return DecorationSet.create(state.doc, [
            Decoration.node(selection.from, selection.to, {}, { [ACTIVE_SPEC]: true }),
          ]);
        }
        for (let depth = $from.depth; depth > 0; depth--) {
          if (ACTIVE_TYPES.has($from.node(depth).type.name)) {
            return DecorationSet.create(state.doc, [
              Decoration.node($from.before(depth), $from.after(depth), {}, { [ACTIVE_SPEC]: true }),
            ]);
          }
        }
        return DecorationSet.empty;
      },
    },
  });
}

// ------------------------------------------------------------------ commands

function listItemDepth(state: EditorState): number {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === 'listItem') return depth;
  }
  return -1;
}

export function isTaskItem(state: EditorState): boolean {
  const depth = listItemDepth(state);
  if (depth < 0) return false;
  const checked = state.selection.$from.node(depth).attrs.checked;
  return checked !== null && checked !== undefined;
}

/** Turn the list item(s) at the selection into tasks, or back into plain items. */
export function toggleTask(editor: Editor): boolean {
  const { state } = editor;
  const depth = listItemDepth(state);
  if (depth >= 0) {
    const makeTask = !isTaskItem(state);
    const tr = state.tr;
    const { from, to } = state.selection;
    const list = state.selection.$from.node(depth - 1);
    const listPos = state.selection.$from.before(depth - 1);
    list.forEach((item, offset) => {
      const pos = listPos + 1 + offset;
      if (pos + item.nodeSize < from || pos > to) return;
      tr.setNodeAttribute(pos, 'checked', makeTask ? (item.attrs.checked ?? false) : null);
    });
    editor.view.dispatch(tr);
    return true;
  }
  if (!editor.chain().focus().toggleBulletList().run()) return false;
  const after = editor.state;
  const itemDepth = listItemDepth(after);
  if (itemDepth < 0) return true;
  editor.view.dispatch(after.tr.setNodeAttribute(after.selection.$from.before(itemDepth), 'checked', false));
  return true;
}

/** Tab / Shift-Tab in a code block: indent or outdent the selected lines. */
function indentCode(editor: Editor, outdent: boolean): boolean {
  const { state } = editor;
  const { $from, from, to } = state.selection;
  if (!$from.parent.type.spec.code) return false;
  const start = $from.start();
  const text = $from.parent.textContent;
  const unit = /^\t/m.test(text) ? '\t' : /^ {2}(?! )/m.test(text) && !/^ {4}/m.test(text) ? '  ' : '    ';
  const relFrom = from - start;
  const relTo = to - start;
  if (!outdent && relFrom === relTo) {
    editor.view.dispatch(state.tr.insertText(unit));
    return true;
  }
  const lineStarts: number[] = [];
  let lineStart = text.lastIndexOf('\n', relFrom - 1) + 1;
  while (lineStart <= relTo) {
    lineStarts.push(lineStart);
    const next = text.indexOf('\n', lineStart);
    if (next < 0 || next >= relTo) break;
    lineStart = next + 1;
  }
  const tr = state.tr;
  for (const line of lineStarts.reverse()) {
    if (outdent) {
      const match = /^(\t| {1,4})/.exec(text.slice(line));
      if (match) tr.delete(start + line, start + line + match[1]!.length);
    } else tr.insertText(unit, start + line);
  }
  if (tr.docChanged) editor.view.dispatch(tr);
  return true;
}

// ------------------------------------------------------------------ extension

export function createBehaviors(services: EditorServices) {
  return Extension.create({
    name: 'liveMarkdownBehavior',
    priority: 50,

    addKeyboardShortcuts() {
      return {
        'Mod-k': () => {
          services.requestLink();
          return true;
        },
        'Mod-Shift-9': () => toggleTask(this.editor),
        Tab: () => indentCode(this.editor, false) || true,
        'Shift-Tab': () => indentCode(this.editor, true) || true,
      };
    },

    addInputRules() {
      const { schema } = this.editor;
      return [
        // "[ ] " / "[x] " at the start of a list item turns it into a task.
        new InputRule({
          find: /^\[([ xX])\]\s$/,
          handler: ({ state, range, match }) => {
            const $from = state.doc.resolve(range.from);
            if ($from.depth < 2 || $from.parentOffset !== 0) return null;
            const item = $from.node(-1);
            if (item.type.name !== 'listItem' || $from.index(-1) !== 0) return null;
            if (item.attrs.checked !== null && item.attrs.checked !== undefined) return null;
            state.tr.delete(range.from, range.to).setNodeAttribute($from.before(-1), 'checked', match[1] !== ' ');
          },
        }),
        // ![alt](src "title")
        new InputRule({
          find: /!\[([^[\]]*)\]\(([^()\s]+)(?:\s+"([^"]*)")?\)$/,
          handler: ({ state, range, match }) => {
            const image = schema.nodes.image;
            if (!image) return null;
            state.tr.replaceWith(range.from, range.to, image.create({ alt: match[1] ?? '', src: match[2], title: match[3] ?? null }));
          },
        }),
        // [text](url "title")
        new InputRule({
          find: /\[([^[\]]+)\]\(([^()\s]+)(?:\s+"([^"]*)")?\)$/,
          handler: ({ state, range, match }) => {
            const link = schema.marks.link;
            if (!link) return null;
            if (range.from > 0 && state.doc.textBetween(range.from - 1, range.from) === '!') return null;
            const marks = state.doc.resolve(range.from).marks().filter((m) => m.type !== link);
            const mark = link.create({ href: match[2], title: match[3] ?? null });
            state.tr.replaceWith(range.from, range.to, schema.text(match[1]!, [...marks, mark])).removeStoredMark(link);
          },
        }),
      ];
    },

    addProseMirrorPlugins() {
      return [linkClickPlugin(services), tablePlugin(), activeBlockPlugin()];
    },
  });
}

/**
 * Markdown clipboard. High priority so it wins over Tiptap's plain-text serializer and over the
 * code block's VS Code paste handler (which would wrap pasted Markdown in a fenced block).
 */
export const MarkdownClipboard = Extension.create({
  name: 'liveMarkdownClipboard',
  priority: 1000,
  addProseMirrorPlugins() {
    return [clipboardPlugin()];
  },
});
