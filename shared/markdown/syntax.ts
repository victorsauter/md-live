/**
 * Obsidian-style live preview (Phase 12): computes the Markdown markers (`**`, `#`, `[…](…)`...)
 * to reveal around the elements touched by the selection. The webview renders them as
 * ProseMirror widget decorations; they never become part of the document.
 */
import type { Mark, Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type EditorState } from '@tiptap/pm/state';
import { DEFAULT_STYLE, type DocStyle } from './types';

export type SyntaxKind = 'heading' | 'link' | 'bold' | 'italic' | 'strike' | 'code';

export interface SyntaxMarker {
  pos: number;
  text: string;
  kind: SyntaxKind;
  /**
   * ProseMirror widget side: negative values are drawn before the cursor at `pos`, positive ones
   * after it; widgets at the same position are drawn in ascending order.
   */
  side: number;
  /** Rendered on its own line (setext heading underline). */
  block?: boolean;
}

const MARK_ORDER: SyntaxKind[] = ['link', 'bold', 'italic', 'strike', 'code'];
/** Textblocks inspected for a multi-block selection; beyond that nothing is revealed. */
const MAX_BLOCKS = 64;

interface Run {
  mark: Mark;
  kind: SyntaxKind;
  from: number;
  to: number;
  text: string;
}

export function syntaxMarkers(state: EditorState, style: DocStyle = DEFAULT_STYLE): SyntaxMarker[] {
  const selection = state.selection;
  if (!(selection instanceof TextSelection)) return [];
  const { from, to, empty, $from } = selection;
  const blocks: Array<{ node: PMNode; pos: number }> = [];
  if (empty) {
    if ($from.parent.isTextblock && $from.depth > 0) blocks.push({ node: $from.parent, pos: $from.before() });
  } else {
    let tooMany = false;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (tooMany) return false;
      if (!node.isTextblock) return true;
      if (blocks.length === MAX_BLOCKS) tooMany = true;
      else blocks.push({ node, pos });
      return false;
    });
    if (tooMany) return [];
  }
  const markers: SyntaxMarker[] = [];
  for (const block of blocks) collectBlock(block.node, block.pos, from, to, style, markers);
  return markers;
}

function collectBlock(
  node: PMNode,
  pos: number,
  from: number,
  to: number,
  style: DocStyle,
  out: SyntaxMarker[],
): void {
  if (node.type.spec.code) return;
  const start = pos + 1;
  const end = pos + node.nodeSize - 1;
  if (node.type.name === 'heading') {
    const level = Number(node.attrs.level) || 1;
    const setext = node.attrs.setext as string | null;
    if (setext) {
      out.push({ pos: end, text: setext.repeat(3), kind: 'heading', side: 1000, block: true });
    } else {
      out.push({ pos: start, text: `${'#'.repeat(level)} `, kind: 'heading', side: -1000 });
    }
  }

  const active = markRuns(node, start).filter((run) => run.from <= to && run.to >= from);
  // Longer runs enclose shorter ones; on ties keep the usual Markdown nesting (links outermost).
  active.sort((a, b) => b.to - b.from - (a.to - a.from) || MARK_ORDER.indexOf(a.kind) - MARK_ORDER.indexOf(b.kind));
  active.forEach((run, rank) => {
    const markers = delimiters(run, style);
    if (!markers) return;
    const [open, close] = markers;
    // At the start of a textblock, typed text joins the mark (cursor drawn after the opener);
    // elsewhere it does not (cursor drawn before the opener).
    const openInside = run.from === start;
    // Inclusive marks keep growing at their end (cursor drawn before the closer).
    const closeInside = run.mark.type.spec.inclusive !== false;
    if (open) out.push({ pos: run.from, text: open, kind: run.kind, side: openInside ? -200 + rank : 101 + rank });
    if (close) out.push({ pos: run.to, text: close, kind: run.kind, side: closeInside ? 100 - rank : -201 - rank });
  });
}

/** Maximal ranges of the textblock covered by each (equal) mark. */
function markRuns(node: PMNode, start: number): Run[] {
  const runs: Run[] = [];
  const open = new Map<Mark, Run>();
  node.forEach((child, offset) => {
    const from = start + offset;
    const to = from + child.nodeSize;
    const next = new Map<Mark, Run>();
    for (const mark of child.marks) {
      const kind = mark.type.name as SyntaxKind;
      if (!MARK_ORDER.includes(kind)) continue;
      let run: Run | undefined;
      for (const [m, r] of open) if (m.eq(mark) && r.to === from) run = r;
      if (run) run.to = to;
      else runs.push((run = { mark, kind, from, to, text: '' }));
      run.text += child.text ?? '';
      next.set(mark, run);
    }
    open.clear();
    for (const [m, r] of next) open.set(m, r);
  });
  return runs;
}

function delimiters(run: Run, style: DocStyle): [string, string] | null {
  const attrs = run.mark.attrs;
  switch (run.kind) {
    case 'bold': {
      const marker = (attrs.marker as string | null) ?? style.strong;
      return [marker, marker];
    }
    case 'italic': {
      const marker = (attrs.marker as string | null) ?? style.emphasis;
      return [marker, marker];
    }
    case 'strike': {
      const marker = (attrs.marker as string | null) ?? '~~';
      return [marker, marker];
    }
    case 'code': {
      const longest = Math.max(0, ...(run.text.match(/`+/g) ?? []).map((ticks) => ticks.length));
      const fence = '`'.repeat(longest + 1);
      return longest ? [`${fence} `, ` ${fence}`] : [fence, fence];
    }
    case 'link':
      return linkDelimiters(attrs);
    default:
      return null;
  }
}

function linkDelimiters(attrs: Mark['attrs']): [string, string] | null {
  const autolink = attrs.autolink as string | null;
  if (autolink === 'literal') return null;
  if (autolink === 'angle') return ['<', '>'];
  const refType = attrs.refType as string | null;
  const refLabel = attrs.refLabel as string | null;
  if (refType === 'full' && refLabel) return ['[', `][${refLabel}]`];
  if (refType === 'collapsed') return ['[', '][]'];
  if (refType === 'shortcut') return ['[', ']'];
  const href = String(attrs.href ?? '');
  const destination = /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, (c) => `\\${c}`)}>` : href;
  const title = attrs.title ? ` "${String(attrs.title).replace(/"/g, '\\"')}"` : '';
  return ['[', `](${destination}${title})`];
}
