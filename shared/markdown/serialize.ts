/**
 * Lossless Markdown serializer.
 *
 * Unchanged blocks are written back byte for byte from the original source (identified through
 * their `sid` attribute and node identity). Changed blocks are patched as locally as possible
 * (a single edited word only rewrites that word); blocks without usable source are generated with
 * the document's detected style. Every changed block, and then the whole document, is parsed back
 * and compared with the edited document; if the result is not equivalent the serializer falls
 * back to full regeneration of the block, and throws if that still fails. Callers must never write
 * when `serializeMarkdown` throws.
 */
import { Mark, type Node as PMNode } from '@tiptap/pm/model';
import { canonicalBlocks, footnoteLabelsOf } from './canonical';
import { escapeText, type InlineKind } from './escape';
import { generateBlock, generateInline, isEmptyParagraph, type GenerateContext } from './generate';
import { parseMarkdown } from './parse';
import { indentLines, lineEndOf, lineStartOf, reprefix, spaces } from './text';
import type { Origin, SourceBase, SplicePoint } from './types';

export class SerializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerializeError';
  }
}

/** Documents larger than this are not re-parsed as a whole after serialization. */
const FULL_CHECK_LIMIT = 300_000;

interface Ctx {
  base: SourceBase;
  src: string;
  gen: GenerateContext;
  used: Set<string>;
  /** Link reference / footnote definitions of the edited document, appended when verifying a block. */
  defs: DefinitionSuffix;
  /** Bullet / delimiter actually written for each list (to keep adjacent lists separate). */
  markers: WeakMap<PMNode, string>;
  trustRaw?: boolean;
}

interface DefinitionSuffix {
  text: string;
  blockCount: number;
  definitions: GenerateContext['definitions'];
  footnotes: Set<string>;
  /** The definitions differ from the ones of the original source. */
  changed: boolean;
}

interface Placed {
  node: PMNode;
  origin: Origin | null;
}

type ContainerKind = 'root' | 'blockquote' | 'item';

const caches = new WeakMap<SourceBase, WeakMap<PMNode, string>>();

function cacheFor(base: SourceBase): WeakMap<PMNode, string> {
  let cache = caches.get(base);
  if (!cache) caches.set(base, (cache = new WeakMap()));
  return cache;
}

function sidOf(node: PMNode): string | null {
  return (node.attrs.sid as string | null | undefined) ?? null;
}

/** Find the (unused) origin of a node. */
function claim(ctx: Ctx, node: PMNode): Origin | null {
  const sid = sidOf(node);
  if (!sid || ctx.used.has(sid)) return null;
  const origin = ctx.base.origins.get(sid);
  if (!origin || origin.type !== node.type.name) return null;
  ctx.used.add(sid);
  return origin;
}

function unchanged(node: PMNode, origin: Origin | null): boolean {
  return !!origin && (origin.node === node || node.eq(origin.node));
}

function slice(ctx: Ctx, origin: Origin, R: string): string {
  return reprefix(ctx.src.slice(origin.start, origin.end), origin.R, R);
}

// ------------------------------------------------------------------ inline patching

interface Atom {
  ch?: string;
  node?: PMNode;
  marks: readonly Mark[];
}

function flatten(node: PMNode): Atom[] {
  const atoms: Atom[] = [];
  node.forEach((child) => {
    if (child.isText) for (const ch of child.text!) for (const unit of ch.length > 1 ? [ch[0]!, ch[1]!] : [ch]) atoms.push({ ch: unit, marks: child.marks });
    else atoms.push({ node: child, marks: child.marks });
  });
  return atoms;
}

function atomEq(a: Atom, b: Atom): boolean {
  if (a.ch !== undefined || b.ch !== undefined) return a.ch === b.ch && Mark.sameSet(a.marks, b.marks);
  return !!a.node && !!b.node && a.node.eq(b.node);
}

const isHigh = (a: Atom | undefined) => !!a?.ch && a.ch >= '\uD800' && a.ch <= '\uDBFF';
const isLow = (a: Atom | undefined) => !!a?.ch && a.ch >= '\uDC00' && a.ch <= '\uDFFF';

function marksContinue(atoms: Atom[], pos: number): boolean {
  if (pos <= 0 || pos >= atoms.length) return false;
  const next = atoms[pos]!.marks;
  return atoms[pos - 1]!.marks.some((m) => m.isInSet(next));
}

function inlineChildren(node: PMNode, from: number, to: number): PMNode[] {
  const out: PMNode[] = [];
  node.content.cut(from, to).forEach((child) => out.push(child));
  return out;
}

/** New source of the content of a textblock, in the coordinates of its original prefix. */
function patchContent(ctx: Ctx, node: PMNode, o: Origin, kind: InlineKind): string {
  const { src } = ctx;
  const cs = o.contentStart!;
  const ce = o.contentEnd!;
  if (node.content.eq(o.node.content)) return src.slice(cs, ce);
  const A = flatten(o.node);
  const B = flatten(node);
  let p = 0;
  while (p < A.length && p < B.length && atomEq(A[p]!, B[p]!)) p++;
  if (p > 0 && isHigh(A[p - 1])) p--;
  let s = 0;
  while (s < A.length - p && s < B.length - p && atomEq(A[A.length - 1 - s]!, B[B.length - 1 - s]!)) s++;
  if (s > 0 && isLow(A[A.length - s])) s--;
  const oldEnd = A.length - s;
  const newEnd = B.length - s;
  const inserted = B.slice(p, newEnd);

  // Level 0a: plain text change inside one source-aligned text run or code span.
  const unit = o.units?.find((u) => (u.kind === 'text' || u.kind === 'code') && u.map && u.from <= p && oldEnd <= u.to);
  if (unit && unit.map) {
    const unitMarks = A[unit.from]!.marks;
    const a = unit.map[p - unit.from]!;
    const b = unit.map[oldEnd - unit.from]!;
    if (a >= 0 && b >= 0 && inserted.every((x) => x.ch !== undefined && Mark.sameSet(x.marks, unitMarks))) {
      const text = inserted.map((x) => x.ch).join('');
      if (unit.kind === 'code') {
        if (!/[`\n]/.test(text)) return src.slice(cs, a) + text + src.slice(b, ce);
      } else {
        const ls = lineStartOf(src, a);
        const lineStart = (a === cs && o.contentAtLineStart === true) || (a !== cs && /^[ \t>]*$/.test(src.slice(ls, a)));
        const escaped = escapeText(text, {
          before: src.slice(Math.max(ls, a === cs ? a : ls), a),
          after: src.slice(b, Math.min(lineEndOf(src, b), ce)),
          lineStart,
          kind,
          R: o.R,
        });
        return src.slice(cs, a) + escaped + src.slice(b, ce);
      }
    }
  }

  // Level 0b: regenerate the smallest region delimited by top-level splice points.
  const points: SplicePoint[] = o.points ?? [];
  const delta = B.length - A.length;
  let li = -1;
  for (let i = 0; i < points.length; i++) if (points[i]!.pos <= p) li = i;
  let ri = -1;
  for (let i = points.length - 1; i >= 0; i--) if (points[i]!.pos >= oldEnd) ri = i;
  if (li < 0 || ri < 0) return generateInlineIn(ctx, node.children, kind, o.R);
  while (li > 0 && marksContinue(B, points[li]!.pos)) li--;
  while (ri < points.length - 1 && marksContinue(B, points[ri]!.pos + delta)) ri++;
  const L = points[li]!;
  const Rp = points[ri]!;
  if (L.pos > Rp.pos + delta) return generateInlineIn(ctx, node.children, kind, o.R);
  const region = generateInlineIn(ctx, inlineChildren(node, L.pos, Rp.pos + delta), kind, o.R);
  return src.slice(cs, L.src) + region + src.slice(Rp.src, ce);
}

function generateInlineIn(ctx: Ctx, nodes: readonly PMNode[], kind: InlineKind, R: string): string {
  const out = generateInline(nodes, kind, ctx.gen);
  return kind === 'paragraph' ? indentLines(out, R) : out;
}

// ------------------------------------------------------------------ leaf blocks

function textblock(ctx: Ctx, node: PMNode, R: string, o: Origin): string {
  const { src } = ctx;
  if (o.contentStart === undefined || node.content.size === 0) return generate(ctx, node, R);
  const isHeading = node.type.name === 'heading';
  const content = patchContent(ctx, node, o, isHeading ? 'heading' : 'paragraph');
  if (!isHeading) return reprefix(content, o.R, R);
  const prefix = src.slice(o.start, o.contentStart);
  let suffix = src.slice(o.contentEnd, o.end);
  const level = node.attrs.level as number;
  const origLevel = o.node.attrs.level as number;
  let result: string;
  if (o.node.attrs.setext == null) {
    result = (level === origLevel ? prefix : prefix.replace(/^#+/, '#'.repeat(level))) + content + suffix;
  } else if (level <= 2) {
    if (level !== origLevel) {
      const at = suffix.lastIndexOf('\n') + 1;
      suffix = suffix.slice(0, at) + suffix.slice(at).replace(/[=-]/g, level === 1 ? '=' : '-');
    }
    result = prefix + content + suffix;
  } else if (!content.includes('\n')) {
    result = '#'.repeat(level) + ' ' + content;
  } else {
    return generate(ctx, node, R);
  }
  return reprefix(result, o.R, R);
}

function codeBlock(ctx: Ctx, node: PMNode, R: string, o: Origin): string {
  const { src } = ctx;
  const orig = o.node;
  const lang = (node.attrs.language as string | null) || null;
  const meta = (node.attrs.meta as string | null) || null;
  const value = node.textContent;
  const newLines = value === '' ? [] : value.split('\n');
  const oldLines = orig.textContent === '' ? [] : orig.textContent.split('\n');
  const indented = orig.attrs.indented === true;
  if (indented && (lang || meta || newLines.length === 0 || newLines[0]!.trim() === '')) return generate(ctx, node, R);
  const spans = o.bodyLines;
  let lp = 0;
  let ls = 0;
  if (spans) {
    const min = Math.min(oldLines.length, newLines.length);
    while (lp < min && oldLines[lp] === newLines[lp]) lp++;
    while (ls < min - lp && oldLines[oldLines.length - 1 - ls] === newLines[newLines.length - 1 - ls]) ls++;
  }
  const linePrefix = indented ? o.R + '    ' : o.R + spaces(o.fenceIndent ?? 0);
  const body = newLines.map((line, i) => {
    if (spans && i < lp) return src.slice(spans[i]!.start, spans[i]!.end);
    if (spans && i >= newLines.length - ls) {
      const j = oldLines.length - (newLines.length - i);
      return src.slice(spans[j]!.start, spans[j]!.end);
    }
    if (indented && i === 0) return '    ' + line;
    return line === '' ? linePrefix.trimEnd() : linePrefix + line;
  });
  if (indented) return reprefix(body.join('\n'), o.R, R);

  let fence = String(orig.attrs.fence ?? ctx.gen.style.fence);
  const fenceChar = fence[0] === '~' ? '~' : '`';
  const wanted = String(node.attrs.fence ?? fence);
  if (wanted[0] === fenceChar && wanted.length >= fence.length) fence = wanted;
  let longest = 0;
  for (const line of newLines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (m && m[1]![0] === fenceChar) longest = Math.max(longest, m[1]!.length);
  }
  const fenceChanged = longest >= fence.length || fence !== orig.attrs.fence;
  if (longest >= fence.length) fence = fenceChar.repeat(longest + 1);
  const origLang = (orig.attrs.language as string | null) || null;
  const origMeta = (orig.attrs.meta as string | null) || null;
  const open =
    !fenceChanged && lang === origLang && meta === origMeta && o.openLine !== undefined
      ? o.openLine
      : fence + (lang ?? '') + (meta ? ' ' + meta : '');
  let close: string | null;
  if (o.closeLine && !fenceChanged) close = src.slice(o.closeLine.start, o.closeLine.end);
  else if (o.closeLine === null && !fenceChanged) close = null;
  else close = o.R + spaces(o.fenceIndent ?? 0) + fence;
  const lines = [open, ...body];
  if (close !== null) lines.push(close);
  return reprefix(lines.join('\n'), o.R, R);
}

// ------------------------------------------------------------------ adjacent lists

function isList(node: PMNode | null | undefined): node is PMNode {
  return !!node && (node.type.name === 'bulletList' || node.type.name === 'orderedList');
}

function ownMarker(ctx: Ctx, node: PMNode): string {
  return node.type.name === 'bulletList' ? String(node.attrs.bullet ?? ctx.gen.style.bullet) : String(node.attrs.delimiter ?? '.');
}

function writtenMarker(ctx: Ctx, node: PMNode): string {
  return ctx.markers.get(node) ?? ownMarker(ctx, node);
}

/**
 * Two adjacent lists of the same kind and marker would merge into a single list when parsed back.
 * Returns whether `node` must use another marker than its own because of the previous list.
 */
function conflictsWithPrevious(ctx: Ctx, node: PMNode, prev: PMNode | null): boolean {
  return isList(node) && isList(prev) && prev.type === node.type && writtenMarker(ctx, prev) === ownMarker(ctx, node);
}

/** Marker for a list: its own one unless that would merge it with the previous or next list. */
function chooseMarker(ctx: Ctx, node: PMNode, prev: PMNode | null, next: PMNode | null): string {
  const own = ownMarker(ctx, node);
  const avoid = new Set<string>();
  if (isList(prev) && prev.type === node.type) avoid.add(writtenMarker(ctx, prev));
  if (isList(next) && next.type === node.type) avoid.add(ownMarker(ctx, next));
  const candidates = node.type.name === 'bulletList' ? [own, '-', '*', '+'] : [own, '.', ')'];
  const marker = candidates.find((m) => !avoid.has(m)) ?? candidates.find((m) => m !== writtenMarker(ctx, prev!)) ?? own;
  ctx.markers.set(node, marker);
  return marker;
}

function generate(ctx: Ctx, node: PMNode, R: string, prev: PMNode | null = null, next: PMNode | null = null): string {
  let bullet: string | undefined;
  let paren: boolean | undefined;
  if (node.type.name === 'bulletList') bullet = chooseMarker(ctx, node, prev, next);
  else if (node.type.name === 'orderedList') paren = chooseMarker(ctx, node, prev, next) === ')';
  return indentLines(generateBlock(node, ctx.gen, { bullet, parenDelimiter: paren }), R);
}

// ------------------------------------------------------------------ containers

function nonEmptyChildren(node: PMNode): PMNode[] {
  return node.children.filter((child) => !isEmptyParagraph(child));
}

function gap(ctx: Ctx, a: Placed, b: Placed, P: string, kind: ContainerKind, tight: boolean): string {
  const oa = a.origin;
  const ob = b.origin;
  if (oa && ob && oa.parent === ob.parent && ob.index === oa.index + 1) {
    return reprefix(ctx.src.slice(oa.end, ob.start), oa.parent ? oa.parent.innerR : '', P);
  }
  if (kind === 'root') return '\n\n';
  if (kind === 'item' && tight && canFollowWithoutBlankLine(a.node, b.node)) return '\n' + P;
  return '\n' + P.trimEnd() + '\n' + P;
}

/** Whether  can start right on the line after  (inside a tight list item). */
function canFollowWithoutBlankLine(a: PMNode, b: PMNode): boolean {
  switch (a.type.name) {
    case 'paragraph':
      return canInterruptParagraph(b);
    case 'heading':
      return !a.attrs.setext;
    case 'horizontalRule':
      return true;
    case 'codeBlock':
      return !a.attrs.indented;
    default:
      return false;
  }
}

/** CommonMark: which blocks may interrupt a paragraph (otherwise they become lazy continuation text). */
function canInterruptParagraph(node: PMNode): boolean {
  switch (node.type.name) {
    case 'heading':
      return !node.attrs.setext;
    case 'blockquote':
    case 'table':
      return true;
    case 'codeBlock':
      return !node.attrs.indented;
    case 'horizontalRule':
      return !String(node.attrs.marker ?? '-').trim().startsWith('-');
    case 'rawBlock':
      return node.attrs.kind === 'math';
    case 'bulletList':
    case 'orderedList': {
      if (node.type.name === 'orderedList' && ((node.attrs.start as number | null) ?? 1) !== 1) return false;
      const first = node.firstChild;
      // An empty list item cannot interrupt a paragraph.
      return !!first && first.children.some((child) => !isEmptyParagraph(child));
    }
    default:
      return false;
  }
}

function children(ctx: Ctx, nodes: PMNode[], P: string, kind: ContainerKind, tight: boolean): string {
  let out = '';
  let prev: Placed | null = null;
  for (const [i, node] of nodes.entries()) {
    const placed: Placed = { node, origin: claim(ctx, node) };
    const text = block(ctx, node, P, placed.origin, prev?.node ?? null, nodes[i + 1] ?? null);
    if (prev) out += gap(ctx, prev, placed, P, kind, tight);
    out += text;
    prev = placed;
  }
  return out;
}

function blockquote(ctx: Ctx, node: PMNode, R: string, o: Origin | null): string {
  let head = '> ';
  let innerR = R + '> ';
  if (o && o.head !== undefined && o.innerR.startsWith(o.R)) {
    head = reprefix(o.head, o.R, R);
    innerR = R + o.innerR.slice(o.R.length);
  }
  const content = nonEmptyChildren(node);
  if (content.length === 0) return head.trimEnd() || '>';
  return head + children(ctx, content, innerR, 'blockquote', false);
}

function setCheckbox(head: string, markerLength: number, checked: boolean | null): string {
  const marker = head.slice(0, markerLength);
  const rest = head.slice(markerLength);
  const box = /^([ \t]+)\[([ xX])\]([ \t]*)/.exec(rest);
  if (box) {
    if (checked === null) return marker + box[1] + rest.slice(box[0].length);
    return marker + box[1] + '[' + (checked ? 'x' : ' ') + ']' + box[3] + rest.slice(box[0].length);
  }
  if (checked === null) return head;
  if (rest.includes('\n') || rest === '') return marker + ' [' + (checked ? 'x' : ' ') + '] ';
  const sp = /^[ \t]*/.exec(rest)![0] || ' ';
  return marker + sp + '[' + (checked ? 'x' : ' ') + '] ' + rest.slice(/^[ \t]*/.exec(rest)![0].length);
}

function listItem(ctx: Ctx, item: PMNode, R: string, io: Origin | null, marker: string, indent: number, tight: boolean): string {
  if (io && io.markerText === marker && unchanged(item, io)) return slice(ctx, io, R);
  const content = nonEmptyChildren(item);
  if (content.length === 0) return marker;
  // A task checkbox only exists in front of a paragraph.
  const checked = content[0]!.type.name === 'paragraph' ? ((item.attrs.checked as boolean | null) ?? null) : null;
  let head: string;
  let innerR: string;
  if (io && io.head !== undefined && io.markerText !== undefined) {
    head = io.head;
    if (io.markerText !== marker) head = marker + head.slice(io.markerText.length);
    const origChecked = (io.node.attrs.checked as boolean | null) ?? null;
    if (checked !== origChecked) head = setCheckbox(head, marker.length, checked);
    head = reprefix(head, io.R, R);
    innerR = R + spaces(io.innerR.length - io.R.length + marker.length - io.markerText.length);
  } else {
    head = marker + ' ' + (checked !== null ? '[' + (checked ? 'x' : ' ') + '] ' : '');
    innerR = R + spaces(indent + marker.length + 1);
  }
  return head + children(ctx, content, innerR, 'item', tight);
}

function list(ctx: Ctx, node: PMNode, R: string, o: Origin | null, prev: PMNode | null, next: PMNode | null): string {
  const ordered = node.type.name === 'orderedList';
  const indent = o?.indent ?? 0;
  const bullet = chooseMarker(ctx, node, prev, next);
  const delimiter = bullet;
  const numbering = o?.numbering ?? 'sequential';
  const start = (node.attrs.start as number | null) ?? 1;
  const tight = node.attrs.tight !== false;
  let out = '';
  let prevPlaced: Placed | null = null;
  let number = start - 1;
  node.forEach((item, _offset, i) => {
    const io = claim(ctx, item);
    let marker = bullet;
    if (ordered) {
      if (numbering === 'sequential') number = start + i;
      else if (numbering === 'same') number = start;
      else number = io?.markerText ? parseInt(io.markerText, 10) : number + 1;
      marker = String(number) + delimiter;
    }
    const placed: Placed = { node: item, origin: io };
    const text = listItem(ctx, item, R, io, marker, indent, tight);
    if (prevPlaced) {
      const oa = prevPlaced.origin;
      if (oa && io && oa.parent === io.parent && io.index === oa.index + 1) {
        out += reprefix(ctx.src.slice(oa.end, io.start), oa.parent ? oa.parent.innerR : '', R);
      } else {
        out += tight ? '\n' + R + spaces(indent) : '\n' + R.trimEnd() + '\n' + R + spaces(indent);
      }
    }
    out += text;
    prevPlaced = placed;
  });
  return out;
}

function delimiterRow(aligns: Array<string | null>): string {
  const cell = (a: string | null) => (a === 'left' ? ':--' : a === 'right' ? '--:' : a === 'center' ? ':-:' : '---');
  return '| ' + aligns.map(cell).join(' | ') + ' |';
}

/** Rewrite the alignment colons of an existing delimiter row, keeping its pipes, padding and widths. */
function patchDelimiterRow(line: string, aligns: Array<string | null>): string | null {
  const m = /^(\s*)(\|?)(.*?)(\|?)(\s*)$/.exec(line);
  if (!m) return null;
  const cells = m[3]!.split('|');
  if (cells.length !== aligns.length) return null;
  const out: string[] = [];
  for (const [i, cell] of cells.entries()) {
    const core = cell.trim();
    if (!/^:?-+:?$/.test(core)) return null;
    const lead = /^\s*/.exec(cell)![0];
    const trail = /\s*$/.exec(cell)![0];
    const a = aligns[i];
    const left = a === 'left' || a === 'center';
    const right = a === 'right' || a === 'center';
    const dashes = Math.max(1, Math.max(core.length, 3) - (left ? 1 : 0) - (right ? 1 : 0));
    out.push(lead + (left ? ':' : '') + '-'.repeat(dashes) + (right ? ':' : '') + trail);
  }
  return m[1]! + m[2]! + out.join('|') + m[4]! + m[5]!;
}

function cellContent(ctx: Ctx, cell: PMNode, co: Origin | null): string {
  if (co && co.contentStart !== undefined) {
    if (cell.content.size === 0) return '';
    return patchContent(ctx, cell, co, 'cell');
  }
  return generateInline(cell.children, 'cell', ctx.gen);
}

function tableRow(ctx: Ctx, row: PMNode, ro: Origin | null): string {
  const { src } = ctx;
  if (ro && unchanged(row, ro)) return src.slice(ro.start, ro.end);
  const cells = row.children;
  const origins = cells.map((cell) => claim(ctx, cell));
  if (ro && ro.cellCount !== undefined) {
    let n = cells.length;
    while (n > ro.cellCount && cells[n - 1]!.content.size === 0 && !origins[n - 1]) n--;
    const ok = n === ro.cellCount && n > 0 && origins.slice(0, n).every((co, i) => co && co.parent === ro && co.index === i);
    if (ok) {
      let out = src.slice(ro.start, origins[0]!.start);
      for (let i = 0; i < n; i++) {
        const co = origins[i]!;
        const cell = cells[i]!;
        if (unchanged(cell, co)) out += src.slice(co.start, co.end);
        else if (co.contentStart !== undefined) {
          out += src.slice(co.start, co.contentStart) + cellContent(ctx, cell, co) + src.slice(co.contentEnd, co.end);
        } else {
          const ins = co.emptyInsert ?? co.start;
          const before = src.slice(co.start, ins);
          const after = src.slice(ins, co.end);
          const text = generateInline(cell.children, 'cell', ctx.gen);
          out += before + (before.endsWith('|') ? ' ' : '') + text + (after.startsWith('|') || after === '' ? ' ' : '') + after;
        }
        if (i < n - 1) out += src.slice(co.end, origins[i + 1]!.start);
      }
      return out + src.slice(origins[n - 1]!.end, ro.end);
    }
  }
  return '| ' + cells.map((cell, i) => cellContent(ctx, cell, origins[i]!)).join(' | ') + ' |';
}

function table(ctx: Ctx, node: PMNode, R: string, o: Origin): string {
  const rows = node.children;
  const columns = Math.max(0, ...rows.map((row) => row.childCount));
  const aligns: Array<string | null> = [];
  const header = node.firstChild!;
  for (let i = 0; i < columns; i++) aligns.push(i < header.childCount ? ((header.child(i).attrs.align as string | null) ?? null) : null);
  const origHeader = o.node.firstChild;
  const origColumns = Math.max(0, ...o.node.children.map((row) => row.childCount));
  let delimChanged = columns !== origColumns || o.delimLine === undefined;
  let alignsChanged = false;
  if (!delimChanged && origHeader) {
    for (let i = 0; i < columns; i++) {
      const before = i < origHeader.childCount ? ((origHeader.child(i).attrs.align as string | null) ?? null) : null;
      if (before !== aligns[i]) alignsChanged = true;
    }
  }
  let delim = o.delimLine ?? '';
  if (alignsChanged) {
    const patched = patchDelimiterRow(delim, aligns);
    if (patched === null) delimChanged = true;
    else delim = patched;
  }
  if (delimChanged) delim = delimiterRow(aligns);
  let out = '';
  let prev: Placed | null = null;
  rows.forEach((row, i) => {
    const ro = claim(ctx, row);
    const text = tableRow(ctx, row, ro);
    if (prev) {
      const oa = prev.origin;
      const adjacent = oa && ro && oa.parent === ro.parent && ro.index === oa.index + 1;
      if (i === 1) out += adjacent && !delimChanged && !alignsChanged ? reprefix(ctx.src.slice(oa.end, ro.start), o.R, R) : '\n' + R + delim + '\n' + R;
      else out += adjacent ? reprefix(ctx.src.slice(oa.end, ro.start), o.R, R) : '\n' + R;
    }
    out += text;
    prev = { node: row, origin: ro };
  });
  if (rows.length === 1) out += '\n' + R + delim;
  return out;
}

function block(ctx: Ctx, node: PMNode, R: string, o: Origin | null, prev: PMNode | null, next: PMNode | null): string {
  if (o && unchanged(node, o) && !conflictsWithPrevious(ctx, node, prev)) return slice(ctx, o, R);
  switch (node.type.name) {
    case 'paragraph':
    case 'heading':
      return o ? textblock(ctx, node, R, o) : generate(ctx, node, R);
    case 'codeBlock':
      return o ? codeBlock(ctx, node, R, o) : generate(ctx, node, R);
    case 'rawBlock':
      return indentLines(String(node.attrs.source ?? ''), R);
    case 'horizontalRule':
      return String(node.attrs.marker ?? ctx.gen.style.hr);
    case 'blockquote':
      return blockquote(ctx, node, R, o);
    case 'bulletList':
    case 'orderedList':
      return list(ctx, node, R, o, prev, next);
    case 'table':
      return o && node.childCount > 0 ? table(ctx, node, R, o) : generate(ctx, node, R);
    default:
      return generate(ctx, node, R, prev, next);
  }
}

// ------------------------------------------------------------------ verification

let lastDefs: DefinitionSuffix | null = null;

/**
 * Definitions are document-wide: a reference link or footnote reference only parses as such when
 * its definition exists somewhere in the document. They are collected from the edited document
 * (not from the original source) so that added or removed definitions are taken into account.
 */
function isDefinition(node: PMNode): boolean {
  const kind = node.attrs.kind as string | null;
  return node.type.name === 'rawBlock' && (kind === 'definition' || kind === 'footnoteDefinition');
}

function definitionText(nodes: Iterable<PMNode>): string {
  const sources: string[] = [];
  for (const node of nodes) if (isDefinition(node)) sources.push(String(node.attrs.source ?? '').trimEnd());
  return sources.join('\n\n');
}

const originalDefinitions = new WeakMap<SourceBase, string>();

function originalDefinitionText(base: SourceBase): string {
  let text = originalDefinitions.get(base);
  if (text === undefined) {
    const nodes = [...base.origins.values()].filter((o) => o.type === 'rawBlock').sort((a, b) => a.start - b.start).map((o) => o.node);
    originalDefinitions.set(base, (text = definitionText(nodes)));
  }
  return text;
}

function definitionSuffix(doc: PMNode, base: SourceBase): DefinitionSuffix {
  const nodes: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'rawBlock') {
      nodes.push(node);
      return false;
    }
    return !node.isTextblock;
  });
  const text = definitionText(nodes);
  const changed = text !== originalDefinitionText(base);
  if (lastDefs && lastDefs.text === text) return { ...lastDefs, changed };
  if (!text) return (lastDefs = { text, blockCount: 0, definitions: new Map(), footnotes: new Set(), changed });
  const parsed = parseMarkdown(text, doc.type.schema);
  return (lastDefs = {
    text,
    blockCount: parsed.doc.childCount,
    definitions: parsed.base.definitions,
    footnotes: footnoteLabelsOf(nodes),
    changed,
  });
}

/**
 * Whether a block may depend on the document's definitions: reference links and images, footnote
 * references, or literal brackets that would become references if a matching definition appeared.
 */
function mentionsReferences(node: PMNode): boolean {
  let found = false;
  node.descendants((child) => {
    if (found) return false;
    if (child.isText && /[[\]]/.test(child.text!)) found = true;
    else if (child.type.name === 'rawInline' && child.attrs.kind === 'footnoteReference') found = true;
    else if (child.type.name === 'image' && child.attrs.refType) found = true;
    else if (child.marks.some((m) => m.type.name === 'link' && m.attrs.refType)) found = true;
    return !found;
  });
  return found;
}

function verifyBlock(ctx: Ctx, text: string, node: PMNode): boolean {
  if (ctx.trustRaw) return true;
  const suffix = ctx.defs;
  try {
    const parsed = parseMarkdown(suffix.text ? text + '\n\n' + suffix.text : text, node.type.schema).doc;
    const blocks = [...parsed.children];
    if (suffix.blockCount) blocks.splice(blocks.length - suffix.blockCount, suffix.blockCount);
    return canonicalBlocks(blocks, suffix.footnotes) === canonicalBlocks([node], suffix.footnotes);
  } catch {
    return false;
  }
}

interface Part {
  node: PMNode;
  origin: Origin | null;
  text: string;
  reused: boolean;
}

function serializeTop(ctx: Ctx, node: PMNode, origin: Origin | null, prev: PMNode | null, next: PMNode | null, force: boolean): string {
  if (!force) {
    try {
      const text = block(ctx, node, '', origin, prev, next);
      if (verifyBlock(ctx, text, node)) return text;
    } catch {
      // fall through to regeneration
    }
  }
  const text = generate(ctx, node, '', prev, next);
  if (verifyBlock(ctx, text, node)) return text;
  throw new SerializeError(`Cannot serialize ${node.type.name} block without changing its meaning`);
}

function assemble(ctx: Ctx, doc: PMNode, regenerate: boolean): { text: string; parts: Part[] } {
  const { src, base } = ctx;
  const cache = cacheFor(base);
  ctx.used.clear();
  ctx.markers = new WeakMap();
  const parts: Part[] = [];
  let prev: PMNode | null = null;
  const blocks = nonEmptyChildren(doc);
  for (const [i, node] of blocks.entries()) {
    const origin = claim(ctx, node);
    const next = blocks[i + 1] ?? null;
    const nearList = isList(node) && ((isList(prev) && prev.type === node.type) || (isList(next) && next.type === node.type));
    // When definitions were added or removed, blocks that may depend on them are regenerated.
    const stale = ctx.defs.changed && mentionsReferences(node);
    let text: string;
    let reused = false;
    if (origin && !stale && unchanged(node, origin) && !conflictsWithPrevious(ctx, node, prev)) {
      text = slice(ctx, origin, '');
      reused = true;
    } else if (!regenerate && !stale && !nearList && cache.has(node)) {
      text = cache.get(node)!;
    } else {
      text = serializeTop(ctx, node, origin, prev, next, regenerate || stale);
    }
    parts.push({ node, origin, text, reused });
    prev = node;
  }
  const first = base.rootOrigins[0];
  const last = base.rootOrigins[base.rootOrigins.length - 1];
  if (parts.length === 0) return { text: first ? '' : src, parts };
  if (!first || !last) return { text: parts.map((p) => p.text).join('\n\n') + '\n', parts };
  let out = '';
  const leading = src.slice(0, first.start);
  out += parts[0]!.origin === first ? leading : leading.slice(0, leading.lastIndexOf('\n') + 1);
  parts.forEach((part, i) => {
    if (i > 0) {
      const a = parts[i - 1]!;
      const changed = regenerate && (!a.reused || !part.reused);
      out += changed ? '\n\n' : gap(ctx, a, part, '', 'root', false);
    }
    out += part.text;
  });
  const trailing = src.slice(last.end);
  out += parts[parts.length - 1]!.origin === last ? trailing : trailing.includes('\n') ? trailing.slice(trailing.indexOf('\n')) : '';
  return { text: out, parts };
}

/**
 * Serialize `doc` to Markdown, reusing the original source described by `base`.
 * Throws `SerializeError` when the document cannot be written without changing its meaning.
 */
export interface SerializeOptions {
  /**
   * The user edited the Markdown source of raw nodes: write it verbatim without semantic
   * verification. The caller must re-parse the result, whose meaning may differ from `doc`.
   */
  trustRaw?: boolean;
}

export function serializeMarkdown(doc: PMNode, base: SourceBase, options: SerializeOptions = {}): string {
  const defs = definitionSuffix(doc, base);
  const ctx: Ctx = {
    base,
    src: base.text,
    gen: { style: base.style, definitions: defs.definitions },
    used: new Set(),
    defs,
    markers: new WeakMap(),
    trustRaw: options.trustRaw ?? false,
  };
  if (ctx.trustRaw) return assemble(ctx, doc, false).text;
  const expected = canonicalBlocks(doc.children, defs.footnotes);
  for (const regenerate of [false, true]) {
    const { text, parts } = assemble(ctx, doc, regenerate);
    if (parts.every((p) => p.reused) && text === base.text) return text;
    if (text.length <= FULL_CHECK_LIMIT) {
      let ok: boolean;
      try {
        ok = canonicalBlocks(parseMarkdown(text, doc.type.schema).doc.children, defs.footnotes) === expected;
      } catch {
        ok = false;
      }
      if (!ok) continue;
    }
    const cache = cacheFor(base);
    for (const part of parts) if (!part.reused) cache.set(part.node, part.text);
    return text;
  }
  throw new SerializeError('The edited document cannot be written as Markdown without changing its meaning');
}
