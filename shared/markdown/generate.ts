/**
 * Markdown generation for blocks that have no usable source (new or heavily modified content).
 * ProseMirror nodes are converted to mdast and serialized with `mdast-util-to-markdown` (the
 * serializer behind remark-stringify) using the style detected in the document.
 */
import type { Mark, Node as PMNode } from '@tiptap/pm/model';
import { defaultHandlers, toMarkdown, type Options, type State, type Info } from 'mdast-util-to-markdown';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { frontmatterToMarkdown } from 'mdast-util-frontmatter';
import { mathToMarkdown } from 'mdast-util-math';
import { isEmptyParagraph } from './canonical';
import { normalizeLabel } from './parse';
import type { InlineKind } from './escape';
import type { Definition, DocStyle } from './types';

type MdNode = { type: string; children?: MdNode[]; [key: string]: unknown };

const WIKILINK_RE = /\[\[[^[\]\n]+\]\]/g;
const MARK_PRIORITY: Record<string, number> = { link: 4, bold: 3, italic: 2, strike: 1, code: 0 };

export interface GenerateContext {
  style: DocStyle;
  definitions: Map<string, Definition>;
}

export { isEmptyParagraph };

// ------------------------------------------------------------------ PM → mdast (inline)

interface Item {
  node: PMNode;
  marks: readonly Mark[];
}

function inlineItems(nodes: readonly PMNode[], kind: InlineKind): Item[] {
  let items: Item[] = nodes.map((node) => {
    // A code span shows its content literally: raw inline syntax under a code mark is code text.
    if (node.type.name === 'rawInline' && node.marks.some((m) => m.type.name === 'code')) {
      const text = node.type.schema.text(String(node.attrs.source ?? '') || ' ', node.marks);
      return { node: text, marks: node.marks };
    }
    // Emphasis cannot span a line break (the closing delimiter would start the next line).
    if (node.type.name === 'hardBreak') return { node, marks: node.marks.filter((m) => m.type.name === 'link') };
    return { node, marks: node.marks };
  });
  // Hard breaks cannot start or end a textblock, and leading or trailing whitespace is not
  // significant (it would be encoded as `&#x20;`).
  /** Trim item `i`; returns whether it was removed. */
  const edge = (i: number, re: RegExp): boolean => {
    const item = items[i];
    if (!item) return false;
    if (item.node.type.name === 'hardBreak') {
      items.splice(i, 1);
      return true;
    }
    if (!item.node.isText || item.marks.some((m) => m.type.name === 'code')) return false;
    const text = item.node.text!.replace(re, '');
    if (text) items[i] = { node: item.node.type.schema.text(text, item.node.marks), marks: item.marks };
    else items.splice(i, 1);
    return !text;
  };
  let trimming = true;
  while (trimming) trimming = edge(0, /^[ \t\n]+/);
  trimming = true;
  while (trimming) trimming = edge(items.length - 1, /[ \t\n]+$/);
  // Spaces around a hard break are not significant (and would be encoded as character references).
  if (kind === 'paragraph') {
    const isBreak = (item: Item | undefined) => item?.node.type.name === 'hardBreak';
    items = items
      .map((item, i) => {
        if (!item.node.isText || item.marks.some((m) => m.type.name === 'code')) return item;
        let text = item.node.text!;
        if (isBreak(items[i + 1])) text = text.replace(/[ \t]+$/, '');
        if (isBreak(items[i - 1])) text = text.replace(/^[ \t]+/, '');
        if (text === item.node.text) return item;
        return text ? { node: item.node.type.schema.text(text, item.node.marks), marks: item.marks } : null;
      })
      .filter((item): item is Item => item !== null);
  }
  if (kind !== 'paragraph') {
    items = items.map((item) => {
      if (item.node.type.name === 'hardBreak' && kind === 'heading') {
        return { node: item.node.type.schema.text(' ', item.marks), marks: item.marks };
      }
      if (item.node.isText && item.node.text!.includes('\n')) {
        return { node: item.node.type.schema.text(item.node.text!.replace(/\n/g, ' '), item.marks), marks: item.marks };
      }
      return item;
    });
  }
  return items;
}

/** Marks that render the same (style attributes such as the emphasis marker are ignored). */
function sameMark(a: Mark, b: Mark): boolean {
  if (a.type !== b.type) return false;
  if (a.type.name !== 'link') return true;
  return a.attrs.href === b.attrs.href && (a.attrs.title || null) === (b.attrs.title || null);
}

function hasMark(marks: readonly Mark[], mark: Mark): boolean {
  return marks.some((m) => sameMark(m, mark));
}

function markRunLength(items: Item[], from: number, mark: Mark): number {
  let n = 0;
  for (let i = from; i < items.length && hasMark(items[i]!.marks, mark); i++) n += items[i]!.node.nodeSize;
  return n;
}

function textOf(nodes: MdNode[]): string {
  return nodes
    .map((n) => (typeof n.value === 'string' ? n.value : n.children ? textOf(n.children) : ''))
    .join('');
}

function markNode(mark: Mark, ctx: GenerateContext): MdNode {
  switch (mark.type.name) {
    case 'bold':
      return { type: 'strong', children: [] };
    case 'italic':
      return { type: 'emphasis', children: [] };
    case 'strike':
      return { type: 'delete', children: [] };
    case 'link': {
      const href = String(mark.attrs.href ?? '');
      const title = (mark.attrs.title as string | null) || null;
      const refType = mark.attrs.refType as string | null;
      const refLabel = mark.attrs.refLabel as string | null;
      if (refType && refLabel) {
        const def = ctx.definitions.get(normalizeLabel(refLabel));
        if (def && def.url === href && (def.title ?? null) === title) {
          return { type: 'linkReference', identifier: normalizeLabel(refLabel), label: refLabel, referenceType: refType, children: [] };
        }
      }
      return { type: 'link', url: href, title, children: [] };
    }
    default:
      return { type: 'emphasis', children: [] };
  }
}

function leaf(item: Item, kind: InlineKind, ctx: GenerateContext): MdNode {
  const node = item.node;
  if (node.isText) {
    if (item.marks.some((m) => m.type.name === 'code')) return { type: 'inlineCode', value: node.text! };
    return { type: 'text', value: node.text! };
  }
  switch (node.type.name) {
    case 'hardBreak':
      return kind === 'cell' ? { type: 'html', value: '<br>' } : { type: 'break' };
    case 'image': {
      const src = String(node.attrs.src ?? '');
      const title = (node.attrs.title as string | null) || null;
      const refType = node.attrs.refType as string | null;
      const refLabel = node.attrs.refLabel as string | null;
      if (refType && refLabel) {
        const def = ctx.definitions.get(normalizeLabel(refLabel));
        if (def && def.url === src && (def.title ?? null) === title) {
          return {
            type: 'imageReference',
            identifier: normalizeLabel(refLabel),
            label: refLabel,
            referenceType: refType,
            alt: String(node.attrs.alt ?? ''),
          };
        }
      }
      return { type: 'image', url: src, title, alt: String(node.attrs.alt ?? '') };
    }
    case 'rawInline':
      return { type: 'rawInline', value: String(node.attrs.source ?? '') };
    default:
      return { type: 'text', value: node.textContent };
  }
}

/** Convert flat ProseMirror inline content (marks) to nested mdast phrasing content. */
export function inlineToMdast(nodes: readonly PMNode[], kind: InlineKind, ctx: GenerateContext): MdNode[] {
  const items = inlineItems(nodes, kind);
  const root: MdNode = { type: 'root', children: [] };
  const stack: Array<{ mark: Mark; node: MdNode }> = [];
  const top = () => (stack.length ? stack[stack.length - 1]!.node : root);
  items.forEach((item, index) => {
    const marks = item.marks.filter((m) => m.type.name !== 'code');
    let keep = 0;
    while (keep < stack.length && hasMark(marks, stack[keep]!.mark)) keep++;
    stack.length = keep;
    const open = marks
      .filter((m) => !stack.some((s) => sameMark(s.mark, m)))
      .sort((a, b) => {
        const diff = markRunLength(items, index, b) - markRunLength(items, index, a);
        return diff !== 0 ? diff : (MARK_PRIORITY[b.type.name] ?? 0) - (MARK_PRIORITY[a.type.name] ?? 0);
      });
    for (const mark of open) {
      const node = markNode(mark, ctx);
      top().children!.push(node);
      stack.push({ mark, node });
    }
    const node = leaf(item, kind, ctx);
    const siblings = top().children!;
    const last = siblings[siblings.length - 1];
    // Adjacent code spans would be juxtaposed (`b) and parsed differently: merge them.
    if (last && (node.type === 'inlineCode' || node.type === 'text') && last.type === node.type) last.value = String(last.value) + String(node.value);
    else siblings.push(node);
  });
  // collapsed / shortcut references require the link text to match the label.
  const fix = (node: MdNode) => {
    if (node.type === 'linkReference' && node.referenceType !== 'full') {
      if (normalizeLabel(textOf(node.children ?? [])) !== normalizeLabel(String(node.label ?? ''))) {
        node.referenceType = 'full';
      }
    }
    node.children?.forEach(fix);
  };
  root.children!.forEach(fix);
  return root.children!;
}

// ------------------------------------------------------------------ PM → mdast (blocks)

export function blockToMdast(node: PMNode, ctx: GenerateContext): MdNode {
  const blocks = (parent: PMNode) =>
    parent.children.filter((child) => !isEmptyParagraph(child)).map((child) => blockToMdast(child, ctx));
  switch (node.type.name) {
    case 'paragraph':
      return { type: 'paragraph', children: inlineToMdast(node.children, 'paragraph', ctx) };
    case 'heading':
      return { type: 'heading', depth: node.attrs.level as number, children: inlineToMdast(node.children, 'heading', ctx) };
    case 'blockquote':
      return { type: 'blockquote', children: blocks(node) };
    case 'bulletList':
    case 'orderedList': {
      const ordered = node.type.name === 'orderedList';
      return {
        type: 'list',
        ordered,
        start: ordered ? ((node.attrs.start as number | null) ?? 1) : null,
        spread: node.attrs.tight === false,
        children: node.children.map((item) => {
          const children = blocks(item);
          return {
            type: 'listItem',
            spread: node.attrs.tight === false,
            checked: children[0]?.type === 'paragraph' ? ((item.attrs.checked as boolean | null) ?? null) : null,
            children,
          };
        }),
      };
    }
    case 'listItem':
      return { type: 'listItem', spread: false, checked: node.attrs.checked ?? null, children: blocks(node) };
    case 'codeBlock':
      return {
        type: 'code',
        lang: (node.attrs.language as string | null) || null,
        meta: (node.attrs.meta as string | null) || null,
        value: node.textContent,
      };
    case 'horizontalRule':
      return { type: 'thematicBreak' };
    case 'table': {
      const columns = Math.max(0, ...node.children.map((row) => row.childCount));
      const first = node.firstChild;
      const align: Array<string | null> = [];
      for (let i = 0; i < columns; i++) align.push((first && i < first.childCount ? (first.child(i).attrs.align as string | null) : null) ?? null);
      return {
        type: 'table',
        align,
        children: node.children.map((row) => {
          const cells: MdNode[] = row.children.map((cell) => ({ type: 'tableCell', children: inlineToMdast(cell.children, 'cell', ctx) }));
          while (cells.length < columns) cells.push({ type: 'tableCell', children: [] });
          return { type: 'tableRow', children: cells };
        }),
      };
    }
    case 'rawBlock':
      return { type: 'rawBlock', value: String(node.attrs.source ?? '') };
    default:
      return { type: 'paragraph', children: [{ type: 'text', value: node.textContent }] };
  }
}

// ------------------------------------------------------------------ toMarkdown

/** Task list items (mdast-util-gfm-task-list-item only supports `.` ordered markers). */
function taskListItem(node: MdNode, parent: MdNode | undefined, state: State, info: Info): string {
  const head = node.children?.[0];
  const checkable = typeof node.checked === 'boolean' && head?.type === 'paragraph';
  const checkbox = '[' + (node.checked ? 'x' : ' ') + '] ';
  const tracker = state.createTracker(info);
  if (checkable) tracker.move(checkbox);
  let value = defaultHandlers.listItem(node as never, parent as never, state, { ...info, ...tracker.current() });
  if (checkable) value = value.replace(/^(?:[*+-]|\d+[.)])([\r\n]| {1,3})/, (marker) => marker + checkbox);
  return value;
}

function textHandler(node: MdNode, parent: MdNode | undefined, state: State, info: Info): string {
  const value = String(node.value ?? '');
  const siblings = parent?.children ?? [];
  const index = siblings.indexOf(node);
  const base = { ...info, afterNode: siblings[index + 1], beforeNode: siblings[index - 1] } as Info;
  const pieces: Array<{ text: string; wiki: boolean }> = [];
  let last = 0;
  for (const match of value.matchAll(WIKILINK_RE)) {
    if (match.index > last) pieces.push({ text: value.slice(last, match.index), wiki: false });
    pieces.push({ text: match[0], wiki: true });
    last = match.index + match[0].length;
  }
  if (last < value.length) pieces.push({ text: value.slice(last), wiki: false });
  // A wikilink is written verbatim only when its content has no Markdown meaning of its own.
  const inCell = state.stack.includes('tableCell' as never);
  for (const piece of pieces) {
    if (piece.wiki && (/[<>`*_\\&$~!]/.test(piece.text) || (inCell && piece.text.includes('|')))) piece.wiki = false;
  }
  if (!pieces.some((p) => p.wiki)) return guardBackslash(state.safe(value, base));
  return guardBackslash(
    pieces
      .map((piece, i) => {
        if (piece.wiki) return piece.text;
        const before = i === 0 ? info.before : pieces[i - 1]!.text.slice(-1);
        const after = i === pieces.length - 1 ? info.after : pieces[i + 1]!.text.charAt(0);
        return state.safe(piece.text, { ...base, before, after });
      })
      .join(''),
  );
}

function oddBackslashesBefore(text: string, end: number): boolean {
  let n = 0;
  for (let i = end - 1; i >= 0 && text[i] === '\\'; i--) n++;
  return n % 2 === 1;
}

/**
 * A literal backslash at the end of a text (or before its last character, which emphasis may
 * re-encode as a character reference) must be escaped so that it cannot combine with what follows.
 */
function guardBackslash(out: string): string {
  if (oddBackslashesBefore(out, out.length)) return out + '\\';
  if (out.length >= 2 && oddBackslashesBefore(out, out.length - 1) && !/[!-/:-@[-`{-~]/.test(out[out.length - 1]!)) {
    return out.slice(0, -1) + '\\' + out.slice(-1);
  }
  return out;
}

function options(ctx: GenerateContext, bullet?: string, delimiterOverride?: boolean): Options {
  const style = ctx.style;
  const primary = (bullet ?? style.bullet) as '-' | '*' | '+';
  const other = primary === '-' ? '*' : '-';
  const hr = style.hr.replace(/\s/g, '');
  const rule = (['*', '-', '_'].includes(hr[0] ?? '') ? hr[0] : '-') as '*' | '-' | '_';
  const raw = (node: unknown) => String((node as MdNode).value ?? '');
  const handlers: Record<string, unknown> = {
    rawBlock: raw,
    rawInline: raw,
    text: textHandler,
    listItem: taskListItem,
  };
  if (style.hardBreak !== '\\') {
    const hardBreak = (_node: unknown, _parent: unknown, state: State, info: Info) => {
      if (state.stack.includes('headingAtx') || state.stack.includes('tableCell' as never)) return /[ \t]/.test(info.before) ? '' : ' ';
      // Trailing spaces after a marker-like character (`-`, `1.`, `#`, `>`...) could turn the
      // line into a block construct, and a line made only of spaces would end the paragraph.
      return /[\p{L}\p{N}]/u.test(info.before) ? '  \n' : '\\\n';
    };

    handlers.break = hardBreak;
  }
  return {
    bullet: primary,
    bulletOther: other,
    bulletOrdered: delimiterOverride ? ')' : '.',
    emphasis: style.emphasis === '_' ? '_' : '*',
    strong: style.strong.startsWith('_') ? '_' : '*',
    fence: style.fence.startsWith('~') ? '~' : '`',
    rule,
    ruleRepetition: Math.max(3, hr.length),
    ruleSpaces: /\s/.test(style.hr),
    listItemIndent: 'one',
    incrementListMarker: true,
    setext: false,
    closeAtx: false,
    resourceLink: false,
    tightDefinitions: true,
    extensions: [gfmToMarkdown({ tablePipeAlign: false }), frontmatterToMarkdown(['yaml', 'toml']), mathToMarkdown({ singleDollarTextMath: false })],
    handlers: handlers as Options['handlers'],
    join: [joinParagraphInterruption(rule) as unknown as NonNullable<Options['join']>[number]],
  };
}

/** CommonMark: which blocks may directly follow (interrupt) a paragraph. */
function canInterruptParagraph(node: MdNode, rule: string): boolean {
  switch (node.type) {
    case 'heading':
    case 'code':
    case 'blockquote':
    case 'table':
    case 'math':
      return true;
    case 'thematicBreak':
      return rule !== '-';
    case 'list': {
      if (node.ordered && ((node.start as number | null) ?? 1) !== 1) return false;
      const first = node.children?.[0];
      return !!first && (first.children?.length ?? 0) > 0;
    }
    default:
      return false;
  }
}

function joinParagraphInterruption(rule: string) {
  return (left: MdNode, right: MdNode, parent: MdNode): number | undefined => {
    if (!('spread' in parent)) return undefined;
    if (left.type === 'paragraph') return canInterruptParagraph(right, rule) ? undefined : 1;
    // After a container, a paragraph would be lazy continuation text: keep a blank line.
    if (parent.type === 'listItem' && left.type !== 'heading' && left.type !== 'thematicBreak' && left.type !== 'code') return 1;
    return undefined;
  };
}

export interface GenerateBlockOptions {
  /** Bullet to use for a list (to avoid merging with an adjacent list). */
  bullet?: string;
  /** Use `)` as ordered list delimiter. */
  parenDelimiter?: boolean;
}

/** Generate Markdown for one block (no trailing newline, lines 2..n without container prefix). */
export function generateBlock(node: PMNode, ctx: GenerateContext, opts: GenerateBlockOptions = {}): string {
  const mdast = blockToMdast(node, ctx);
  let bullet = opts.bullet;
  let paren = opts.parenDelimiter;
  if (bullet === undefined && mdast.type === 'list' && node.attrs.bullet) bullet = node.attrs.bullet as string;
  if (paren === undefined && mdast.type === 'list' && node.attrs.delimiter === ')') paren = true;
  const out = toMarkdown(mdast as never, options(ctx, bullet, paren));
  return out.replace(/\n$/, '');
}

/** Generate Markdown for inline content inside a paragraph, heading or table cell. */
export function generateInline(nodes: readonly PMNode[], kind: InlineKind, ctx: GenerateContext): string {
  const children = inlineToMdast(nodes, kind, ctx);
  if (children.length === 0) return '';
  const opts = options(ctx);
  if (kind === 'paragraph') return toMarkdown({ type: 'paragraph', children } as never, opts).replace(/\n$/, '');
  if (kind === 'heading') {
    const out = toMarkdown({ type: 'heading', depth: 1, children } as never, opts).replace(/\n$/, '');
    return out.replace(/^# ?/, '');
  }
  const out = toMarkdown(
    { type: 'table', align: [null], children: [{ type: 'tableRow', children: [{ type: 'tableCell', children }] }] } as never,
    opts,
  );
  const line = out.split('\n')[0] ?? '';
  return line.replace(/^\| ?/, '').replace(/ ?\|$/, '');
}
