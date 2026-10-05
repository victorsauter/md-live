/**
 * Canonical form of a document: what a Markdown reader would render, ignoring presentation
 * details the serializer is allowed to change (bullet characters, fences, tightness, escaping,
 * whitespace that Markdown collapses...). Used to verify that serialized Markdown parses back to
 * the edited document before anything is written.
 */
import type { Mark, Node as PMNode } from '@tiptap/pm/model';

type Canon = unknown;

const FORMATTING = new Set(['bold', 'italic', 'strike']);
const BR_RE = /^<br\s*\/?>$/i;

function markKey(mark: Mark): string {
  if (mark.type.name === 'link') {
    return `link:${String(mark.attrs.href ?? '')}:${String(mark.attrs.title ?? '')}`;
  }
  return mark.type.name;
}

function isLiteralAutolink(text: string, href: string): boolean {
  return href === text || href === `http://${text}` || href === `https://${text}` || href === `mailto:${text}`;
}

interface Run {
  kind: 'text' | 'atom';
  text: string;
  marks: string[];
  atom?: Canon;
}

type InlineMode = 'paragraph' | 'heading' | 'cell';

/**
 * Labels of the footnote definitions present in the document being canonicalised. A footnote
 * reference only parses as such when its definition exists; otherwise it is plain text.
 */
let footnoteLabels: ReadonlySet<string> | null = null;

function inlineCanon(node: PMNode, mode: InlineMode): Canon {
  // Literal autolinks (GFM) are recognised from plain text: treat them as plain text.
  const linkText = new Map<string, string>();
  node.forEach((child) => {
    const link = child.marks.find((m) => m.type.name === 'link');
    if (link) linkText.set(markKey(link), (linkText.get(markKey(link)) ?? '') + (child.isText ? child.text! : '\uFFFC'));
  });
  const runs: Run[] = [];
  node.forEach((child) => {
    const marks = child.marks
      .filter((m) => !(m.type.name === 'link' && isLiteralAutolink(linkText.get(markKey(m)) ?? '', String(m.attrs.href ?? ''))))
      .map(markKey)
      .sort();
    if (child.isText) {
      const isCode = marks.includes('code');
      let text = child.text!;
      if (isCode || mode !== 'paragraph') text = text.replace(/\n/g, ' ');
      // Whitespace cannot carry emphasis in Markdown: split it out.
      if (isCode) {
        runs.push({ kind: 'text', text, marks });
        return;
      }
      for (const part of text.split(/([ \t\n]+)/)) {
        if (!part) continue;
        const ws = /^[ \t\n]+$/.test(part);
        runs.push({ kind: 'text', text: part, marks: ws ? marks.filter((m) => !FORMATTING.has(m)) : marks });
      }
      return;
    }
    const type = child.type.name;
    if (type === 'hardBreak') {
      runs.push(mode === 'heading' ? { kind: 'text', text: ' ', marks: marks.filter((m) => !FORMATTING.has(m) && m !== 'code') } : { kind: 'atom', text: '\n', marks: [], atom: 'br' });
      return;
    }
    if (type === 'rawInline') {
      const source = String(child.attrs.source ?? '');
      const danglingFootnote =
        child.attrs.kind === 'footnoteReference' && footnoteLabels !== null && !footnoteLabels.has(String(child.attrs.label ?? ''));
      if (child.attrs.kind === 'wikilink' || marks.includes('code') || danglingFootnote) {
        runs.push({ kind: 'text', text: source, marks });
        return;
      }
      if (BR_RE.test(source.trim()) && mode === 'cell') {
        runs.push({ kind: 'atom', text: '\n', marks: [], atom: 'br' });
        return;
      }
      runs.push({ kind: 'atom', text: '', marks, atom: ['raw', source] });
      return;
    }
    if (type === 'image') {
      runs.push({
        kind: 'atom',
        text: '',
        marks: marks.filter((m) => m !== 'code'),
        atom: ['img', String(child.attrs.src ?? ''), String(child.attrs.alt ?? ''), String(child.attrs.title ?? '')],
      });
      return;
    }
    runs.push({ kind: 'atom', text: '', marks, atom: [type, child.textContent] });
  });
  // Merge adjacent text runs with identical marks.
  const merged: Run[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.kind === 'text' && run.kind === 'text' && prev.marks.join() === run.marks.join()) prev.text += run.text;
    else merged.push({ ...run, marks: [...run.marks] });
  }
  // Whitespace normalisation around line breaks and at the edges.
  const isBreak = (r: Run | undefined) => !!r && r.kind === 'atom' && r.atom === 'br';
  for (let i = 0; i < merged.length; i++) {
    const run = merged[i]!;
    if (run.kind !== 'text' || run.marks.includes('code')) continue;
    run.text = run.text.replace(/[ \t]*\n[ \t\n]*/g, '\n');
    if (isBreak(merged[i + 1])) run.text = run.text.replace(/[ \t\n]+$/, '');
    if (isBreak(merged[i - 1])) run.text = run.text.replace(/^[ \t\n]+/, '');
  }
  let out = merged.filter((r) => r.kind === 'atom' || r.text !== '');
  while (out.length && (isBreak(out[0]) || (out[0]!.kind === 'text' && !out[0]!.marks.includes('code') && /^[ \t\n]*$/.test(out[0]!.text)))) out.shift();
  while (out.length && (isBreak(out[out.length - 1]) || (out[out.length - 1]!.kind === 'text' && !out[out.length - 1]!.marks.includes('code') && /^[ \t\n]*$/.test(out[out.length - 1]!.text)))) out.pop();
  if (out.length) {
    const first = out[0]!;
    if (first.kind === 'text' && !first.marks.includes('code')) first.text = first.text.replace(/^[ \t\n]+/, '');
    const last = out[out.length - 1]!;
    if (last.kind === 'text' && !last.marks.includes('code')) last.text = last.text.replace(/[ \t\n]+$/, '');
  }
  // Re-merge after trimming.
  const final: Run[] = [];
  for (const run of out) {
    const prev = final[final.length - 1];
    if (prev && prev.kind === 'text' && run.kind === 'text' && prev.marks.join() === run.marks.join()) prev.text += run.text;
    else final.push(run);
  }
  out = final;
  return out.map((r) => (r.kind === 'text' ? [r.text, r.marks.join(',')] : [r.atom, r.marks.join(',')]));
}

/** A paragraph that Markdown cannot represent (no content, or only whitespace and line breaks). */
export function isEmptyParagraph(node: PMNode): boolean {
  if (node.type.name !== 'paragraph') return false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type.name === 'hardBreak') continue;
    if (child.isText && /^[ \t\n]*$/.test(child.text!)) continue;
    return false;
  }
  return true;
}

function blocksCanon(parent: PMNode): Canon[] {
  const out: Canon[] = [];
  parent.forEach((child) => {
    if (!isEmptyParagraph(child)) out.push(blockCanon(child));
  });
  return out;
}

export function blockCanon(node: PMNode): Canon {
  switch (node.type.name) {
    case 'paragraph':
      return ['p', inlineCanon(node, 'paragraph')];
    case 'heading':
      return ['h', node.attrs.level, inlineCanon(node, 'heading')];
    case 'blockquote':
      return ['quote', blocksCanon(node)];
    case 'bulletList':
      return ['ul', node.children.map(itemCanon)];
    case 'orderedList':
      return ['ol', node.attrs.start ?? 1, node.children.map(itemCanon)];
    case 'listItem':
      return itemCanon(node);
    case 'codeBlock':
      return ['code', node.attrs.language || '', node.attrs.meta || '', node.textContent.replace(/\n$/, '')];
    case 'horizontalRule':
      return ['hr'];
    case 'table': {
      // GFM alignment is per column (taken from the header row); rows are padded to the widest one.
      const columns = Math.max(0, ...node.children.map((row) => row.childCount));
      const header = node.firstChild;
      const align: Array<string | null> = [];
      for (let i = 0; i < columns; i++) align.push(header && i < header.childCount ? ((header.child(i).attrs.align as string | null) ?? null) : null);
      const rows = node.children.map((row) => {
        const cells = row.children.map((cell) => inlineCanon(cell, 'cell'));
        while (cells.length && (cells[cells.length - 1] as unknown[]).length === 0) cells.pop();
        return cells;
      });
      return ['table', align, rows];
    }
    case 'rawBlock':
      return ['raw', String(node.attrs.source ?? '').replace(/\s+$/, '')];
    default:
      return [node.type.name, node.textContent];
  }
}

function itemCanon(item: PMNode): Canon {
  const content = blocksCanon(item);
  // A task checkbox only exists in front of a paragraph.
  const first = item.children.find((child) => !isEmptyParagraph(child));
  return ['li', first?.type.name === 'paragraph' ? (item.attrs.checked ?? null) : null, content];
}

/** Labels of the footnote definitions contained in `nodes` (at any depth). */
export function footnoteLabelsOf(nodes: readonly PMNode[]): Set<string> {
  const labels = new Set<string>();
  const visit = (node: PMNode) => {
    if (node.type.name === 'rawBlock') {
      if (node.attrs.kind === 'footnoteDefinition' && node.attrs.label) labels.add(String(node.attrs.label));
      return false;
    }
    return !node.isTextblock;
  };
  for (const node of nodes) if (visit(node) !== false) node.descendants(visit);
  return labels;
}

/**
 * Canonical JSON of a sequence of blocks (empty paragraphs are ignored). `footnotes` are the
 * footnote labels defined in the document; when omitted, footnote references are kept as is.
 */
export function canonicalBlocks(blocks: readonly PMNode[], footnotes?: ReadonlySet<string>): string {
  footnoteLabels = footnotes ?? null;
  try {
    return JSON.stringify(blocks.filter((b) => !isEmptyParagraph(b)).map(blockCanon));
  } finally {
    footnoteLabels = null;
  }
}

export function canonicalDoc(doc: PMNode): string {
  return canonicalBlocks(doc.children, footnoteLabelsOf(doc.children));
}
