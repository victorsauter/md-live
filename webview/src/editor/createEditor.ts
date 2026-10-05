/**
 * Builds the Tiptap editor of the Live mode from the shared document model, adding node views,
 * syntax highlighting, history and editing behaviour.
 */
import { Editor, Extension, type AnyExtension, type NodeViewRenderer } from '@tiptap/core';
import { Dropcursor, Gapcursor, Placeholder, UndoRedo } from '@tiptap/extensions';
import { createMarkdownExtensions } from '../../../shared/markdown/schema';
import { createBehaviors, MarkdownClipboard } from './behaviors';
import { highlightPlugin } from './highlight';
import { codeBlockView, imageView, listItemView, rawBlockView, rawInlineView } from './nodeviews';
import type { EditorServices } from './services';
import { syntaxRevealPlugin } from './syntax';
import { TableKeys } from './table';

const Highlight = Extension.create({
  name: 'liveMarkdownHighlight',
  addProseMirrorPlugins() {
    return [highlightPlugin()];
  },
});

function withNodeViews(extensions: AnyExtension[], views: Record<string, NodeViewRenderer>): AnyExtension[] {
  return extensions.map((extension) => {
    const view = views[extension.name];
    if (!view || extension.type !== 'node') return extension;
    return extension.extend({ addNodeView: () => view });
  });
}

export interface CreateEditorOptions {
  element: HTMLElement;
  services: EditorServices;
  /** Called for every transaction (including appended ones) dispatched to the view. */
  onTransaction(transaction: import('@tiptap/pm/state').Transaction): void;
}

export function createEditor({ element, services, onTransaction }: CreateEditorOptions): Editor {
  const extensions = [
    ...withNodeViews(createMarkdownExtensions(), {
      codeBlock: codeBlockView(services),
      image: imageView(services),
      listItem: listItemView(),
      rawBlock: rawBlockView(services),
      rawInline: rawInlineView(services),
    }),
    UndoRedo.configure({ depth: 500, newGroupDelay: 600 }),
    Dropcursor.configure({ width: 2, class: 'lm-dropcursor' }),
    Gapcursor,
    Placeholder.configure({ placeholder: 'Start writing…', showOnlyCurrent: false }),
    Highlight,
    Extension.create({
      name: 'liveMarkdownSyntax',
      addProseMirrorPlugins: () => [syntaxRevealPlugin(services)],
    }),
    TableKeys,
    MarkdownClipboard,
    createBehaviors(services),
  ];

  const editor = new Editor({
    element,
    extensions,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    injectCSS: false,
    enableInputRules: true,
    enablePasteRules: true,
    autofocus: false,
    editorProps: {
      attributes: { class: 'lm-editor markdown-body', spellcheck: 'true', role: 'textbox', 'aria-multiline': 'true' },
    },
    onTransaction: ({ transaction, appendedTransactions }) => {
      onTransaction(transaction);
      for (const appended of appendedTransactions ?? []) onTransaction(appended);
    },
  });
  return editor;
}
