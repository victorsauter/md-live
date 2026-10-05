/**
 * ProseMirror / Tiptap schema shared by the webview and the unit tests.
 *
 * Every node created from Markdown carries a `sid` (source id) attribute that links it to the
 * original source slice it was parsed from (see `parse.ts`). Presentation details that Markdown
 * allows to vary (bullet character, fence, emphasis marker, setext underline...) are stored as
 * attributes so that regenerated blocks keep the author's style. These attributes are never
 * rendered to the DOM, so copy/paste produces fresh nodes.
 */
import { Extension, Mark, Node, getSchema, mergeAttributes, type AnyExtension } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Heading from '@tiptap/extension-heading';
import Blockquote from '@tiptap/extension-blockquote';
import CodeBlock from '@tiptap/extension-code-block';
import HorizontalRule from '@tiptap/extension-horizontal-rule';
import HardBreak from '@tiptap/extension-hard-break';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Strike from '@tiptap/extension-strike';
import Code from '@tiptap/extension-code';
import Link from '@tiptap/extension-link';
import { BulletList, OrderedList, ListItem } from '@tiptap/extension-list';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import type { Schema } from '@tiptap/pm/model';

/** Block node types that receive a `sid` attribute. */
export const SOURCED_NODE_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'horizontalRule',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'rawBlock',
] as const;

const hidden = (defaultValue: unknown) => ({
  default: defaultValue,
  rendered: false,
  keepOnSplit: true,
});

export const SourceId = Extension.create({
  name: 'sourceId',
  addGlobalAttributes() {
    return [
      {
        types: [...SOURCED_NODE_TYPES],
        attributes: { sid: { default: null, rendered: false, keepOnSplit: false } },
      },
    ];
  },
});

export const MdHeading = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      setext: hidden(null),
    };
  },
}).configure({ levels: [1, 2, 3, 4, 5, 6] });

export const MdBulletList = BulletList.extend({
  addAttributes() {
    return {
      bullet: hidden(null),
      tight: hidden(true),
    };
  },
});

export const MdOrderedList = OrderedList.extend({
  addAttributes() {
    return {
      start: {
        default: 1,
        parseHTML: (element: HTMLElement) =>
          element.hasAttribute('start') ? parseInt(element.getAttribute('start') || '1', 10) : 1,
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.start !== 1 ? { start: attributes.start } : {},
      },
      delimiter: hidden(null),
      tight: hidden(true),
    };
  },
});

export const MdListItem = ListItem.extend({
  content: 'block+',
  addAttributes() {
    return {
      checked: {
        default: null,
        keepOnSplit: false,
        parseHTML: (element: HTMLElement) => {
          const value = element.getAttribute('data-checked');
          return value === 'true' ? true : value === 'false' ? false : null;
        },
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.checked == null ? {} : { 'data-checked': String(attributes.checked), 'data-task': '' },
      },
    };
  },
});

export const MdCodeBlock = CodeBlock.extend({
  addAttributes() {
    return {
      language: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const code = element.querySelector('code');
          const cls = (code?.getAttribute('class') ?? element.getAttribute('class') ?? '').split(/\s+/);
          const lang = cls.find((c) => c.startsWith('language-'));
          return lang ? lang.slice('language-'.length) : null;
        },
        rendered: false,
      },
      meta: hidden(null),
      fence: hidden(null),
      indented: hidden(false),
    };
  },
}).configure({ enableTabIndentation: false });

export const MdHorizontalRule = HorizontalRule.extend({
  addAttributes() {
    return { marker: hidden(null) };
  },
});

export const MdHardBreak = HardBreak.extend({
  addAttributes() {
    return { marker: { default: null, rendered: false, keepOnSplit: false } };
  },
});

export const MdBold = Bold.extend({
  addAttributes() {
    return { marker: { default: null, rendered: false } };
  },
});

export const MdItalic = Italic.extend({
  addAttributes() {
    return { marker: { default: null, rendered: false } };
  },
});

export const MdStrike = Strike.extend({
  addAttributes() {
    return { marker: { default: null, rendered: false } };
  },
});

/** Markdown allows `**`code`**` and `[`code`](url)`, so inline code must not exclude other marks. */
export const MdCode = Code.extend({
  excludes: '',
});

export const MdLink = Link.extend({
  inclusive: false,
  addAttributes() {
    return {
      href: { default: null },
      title: { default: null },
      refType: { default: null, rendered: false },
      refLabel: { default: null, rendered: false },
      autolink: { default: null, rendered: false },
    };
  },
}).configure({
  openOnClick: false,
  autolink: true,
  linkOnPaste: true,
  enableClickSelection: false,
  defaultProtocol: 'https',
  protocols: ['mailto', 'vscode', 'file'],
  isAllowedUri: () => true,
});

/** Inline image (Markdown images are inline content). */
export const MdImage = Node.create({
  name: 'image',
  inline: true,
  group: 'inline',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: '' },
      alt: { default: '' },
      title: { default: null },
      refType: { default: null, rendered: false },
      refLabel: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (element) => {
          const el = element as HTMLElement;
          return {
            src: el.getAttribute('data-src') ?? el.getAttribute('src') ?? '',
            alt: el.getAttribute('alt') ?? '',
            title: el.getAttribute('title'),
          };
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes)];
  },
});

/**
 * Block construct the editor does not edit structurally (HTML, front matter, definitions,
 * footnote definitions, math, unknown nodes). Its Markdown source is kept verbatim.
 */
export const RawBlock = Node.create({
  name: 'rawBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      source: { default: '', rendered: false },
      kind: { default: 'unknown', rendered: false },
      label: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'pre[data-raw-block]',
        getAttrs: (element) => {
          const el = element as HTMLElement;
          return { source: el.textContent ?? '', kind: el.getAttribute('data-kind') ?? 'html' };
        },
      },
    ];
  },
  renderHTML({ node }) {
    return ['pre', { 'data-raw-block': '', 'data-kind': node.attrs.kind }, node.attrs.source];
  },
});

/** Inline counterpart of `RawBlock` (inline HTML, [[wikilinks]], footnote references, math...). */
export const RawInline = Node.create({
  name: 'rawInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      source: { default: '', rendered: false },
      kind: { default: 'unknown', rendered: false },
      label: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-raw-inline]',
        getAttrs: (element) => {
          const el = element as HTMLElement;
          return { source: el.textContent ?? '', kind: el.getAttribute('data-kind') ?? 'html' };
        },
      },
    ];
  },
  renderHTML({ node }) {
    return ['span', { 'data-raw-inline': '', 'data-kind': node.attrs.kind }, node.attrs.source];
  },
});

const alignAttribute = {
  align: {
    default: null,
    parseHTML: (element: HTMLElement) => element.style.textAlign || element.getAttribute('align') || null,
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes.align ? { style: `text-align: ${attributes.align as string}` } : {},
  },
};

export const MdTable = Table.extend({
  content: 'tableRow+',
}).configure({ resizable: false, allowTableNodeSelection: true });

export const MdTableRow = TableRow.extend({});

export const MdTableCell = TableCell.extend({
  content: 'inline*',
  addAttributes() {
    return { ...this.parent?.(), ...alignAttribute };
  },
});

export const MdTableHeader = TableHeader.extend({
  content: 'inline*',
  addAttributes() {
    return { ...this.parent?.(), ...alignAttribute };
  },
});

/**
 * Extensions defining the document model. The webview extends some of them with node views and
 * editing behaviour; the node/mark names and attributes must stay identical.
 */
export function createMarkdownExtensions(): AnyExtension[] {
  return [
    Document,
    Paragraph,
    Text,
    MdHeading,
    Blockquote,
    MdBulletList,
    MdOrderedList,
    MdListItem,
    MdCodeBlock,
    MdHorizontalRule,
    MdHardBreak,
    MdImage,
    RawBlock,
    RawInline,
    MdTable,
    MdTableRow,
    MdTableHeader,
    MdTableCell,
    MdBold,
    MdItalic,
    MdStrike,
    MdCode,
    MdLink,
    SourceId,
  ];
}

let cachedSchema: Schema | undefined;

/** Schema built from `createMarkdownExtensions()` (no DOM required). */
export function getMarkdownSchema(): Schema {
  cachedSchema ??= getSchema(createMarkdownExtensions());
  return cachedSchema;
}

export { Mark };
