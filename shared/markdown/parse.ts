/**
 * Markdown → ProseMirror document, keeping a source map (`Origin`) for every block so that the
 * serializer can reuse the original text of everything that was not modified.
 */
import type { Mark, Node as PMNode, Schema } from '@tiptap/pm/model';
import { alignText } from './align';
import { parseMdast } from './mdast';
import { columnOf, dedentLines, lineEndOf, lineStartOf, spaces } from './text';
import {
  DEFAULT_STYLE,
  type Definition,
  type DocStyle,
  type Origin,
  type SourceBase,
  type SplicePoint,
  type Unit,
} from './types';

interface MNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MNode[];
  value?: string;
  [key: string]: unknown;
}

export interface ParseResult {
  doc: PMNode;
  base: SourceBase;
}

/** Same normalisation as mdast `identifier`. */
export function normalizeLabel(label: string): string {
  return label
    .replace(/[\t\n\r ]+/g, ' ')
    .trim()
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

const WIKILINK_RE = /\[\[[^[\]\n]+\]\]/g;

let generation = 0;

class Counter {
  private readonly counts = new Map<string, number>();
  add(value: string | null | undefined): void {
    if (value) this.counts.set(value, (this.counts.get(value) ?? 0) + 1);
  }
  best(fallback: string): string {
    let best = fallback;
    let max = 0;
    for (const [value, count] of this.counts) {
      if (count > max) {
        best = value;
        max = count;
      }
    }
    return best;
  }
}

interface InlineAcc {
  nodes: PMNode[];
  units: Unit[];
  points: SplicePoint[];
  pos: number;
}

class Parser {
  readonly origins = new Map<string, Origin>();
  readonly rootOrigins: Origin[] = [];
  readonly definitions = new Map<string, Definition>();
  private readonly gen = ++generation;
  private counter = 0;
  private readonly style = {
    bullet: new Counter(),
    emphasis: new Counter(),
    strong: new Counter(),
    fence: new Counter(),
    hr: new Counter(),
    hardBreak: new Counter(),
  };

  constructor(
    private readonly src: string,
    private readonly schema: Schema,
  ) {}

  parse(): ParseResult {
    const root = parseMdast(this.src) as unknown as MNode;
    this.collectDefinitions(root);
    const blocks = (root.children ?? []).map((child, index) => this.block(child, '', null, index));
    if (blocks.length === 0) blocks.push(this.schema.nodes.paragraph!.create());
    const doc = this.schema.topNodeType.create(null, blocks);
    return {
      doc,
      base: {
        text: this.src,
        origins: this.origins,
        rootOrigins: this.rootOrigins,
        style: this.detectedStyle(),
        definitions: this.definitions,
      },
    };
  }

  private detectedStyle(): DocStyle {
    return {
      bullet: this.style.bullet.best(DEFAULT_STYLE.bullet),
      emphasis: this.style.emphasis.best(DEFAULT_STYLE.emphasis),
      strong: this.style.strong.best(DEFAULT_STYLE.strong),
      fence: this.style.fence.best(DEFAULT_STYLE.fence),
      hr: this.style.hr.best(DEFAULT_STYLE.hr),
      hardBreak: this.style.hardBreak.best(DEFAULT_STYLE.hardBreak),
    };
  }

  private collectDefinitions(node: MNode): void {
    if (node.type === 'definition') {
      const id = normalizeLabel(String(node.identifier ?? node.label ?? ''));
      if (!this.definitions.has(id)) {
        this.definitions.set(id, { url: String(node.url ?? ''), title: (node.title as string | null) ?? null });
      }
    }
    for (const child of node.children ?? []) this.collectDefinitions(child);
  }

  private start(node: MNode): number {
    return node.position?.start.offset ?? 0;
  }

  private end(node: MNode): number {
    return node.position?.end.offset ?? 0;
  }

  private col(offset: number): number {
    return columnOf(this.src, offset);
  }

  private origin(node: MNode, type: string, R: string, parent: Origin | null, index: number): Origin {
    const origin: Origin = {
      sid: `g${this.gen}n${++this.counter}`,
      type,
      node: undefined as unknown as PMNode,
      start: this.start(node),
      end: this.end(node),
      R,
      innerR: R,
      parent,
      index,
    };
    this.origins.set(origin.sid, origin);
    if (!parent) this.rootOrigins.push(origin);
    return origin;
  }

  private emptyParagraph(): PMNode {
    return this.schema.nodes.paragraph!.create();
  }

  private block(m: MNode, R: string, parent: Origin | null, index: number): PMNode {
    const { schema, src } = this;
    const s = this.start(m);
    const e = this.end(m);
    switch (m.type) {
      case 'paragraph': {
        const o = this.origin(m, 'paragraph', R, parent, index);
        o.contentStart = s;
        o.contentEnd = e;
        o.contentAtLineStart = true;
        const acc = this.inlines(m.children ?? [], s, e);
        o.units = acc.units;
        o.points = acc.points;
        return (o.node = schema.nodes.paragraph!.create({ sid: o.sid }, acc.nodes));
      }
      case 'heading': {
        const o = this.origin(m, 'heading', R, parent, index);
        const atx = src[s] === '#';
        const children = m.children ?? [];
        let setext: string | null = null;
        if (!atx) {
          const underline = src.slice(lineStartOf(src, e), e).replace(/^[\s>]*/, '');
          setext = underline[0] === '-' ? '-' : '=';
        }
        let nodes: PMNode[] = [];
        if (children.length > 0) {
          const cs = this.start(children[0]!);
          const ce = this.end(children[children.length - 1]!);
          o.contentStart = cs;
          o.contentEnd = ce;
          o.contentAtLineStart = !atx;
          const acc = this.inlines(children, cs, ce);
          o.units = acc.units;
          o.points = acc.points;
          nodes = acc.nodes;
        }
        return (o.node = schema.nodes.heading!.create(
          { sid: o.sid, level: m.depth as number, setext },
          nodes,
        ));
      }
      case 'thematicBreak': {
        const o = this.origin(m, 'horizontalRule', R, parent, index);
        const marker = src.slice(s, e);
        this.style.hr.add(marker);
        return (o.node = schema.nodes.horizontalRule!.create({ sid: o.sid, marker }));
      }
      case 'blockquote': {
        const o = this.origin(m, 'blockquote', R, parent, index);
        const after = src[s + 1];
        o.innerR = R + spaces(this.col(s) - R.length) + '>' + (after === ' ' || after === '\t' ? ' ' : '');
        const children = m.children ?? [];
        o.head = children.length > 0 ? src.slice(s, this.start(children[0]!)) : src.slice(s, e);
        const content = children.map((child, i) => this.block(child, o.innerR, o, i));
        if (content.length === 0) content.push(this.emptyParagraph());
        return (o.node = schema.nodes.blockquote!.create({ sid: o.sid }, content));
      }
      case 'list':
        return this.list(m, R, parent, index);
      case 'code':
        return this.code(m, R, parent, index);
      case 'table':
        return this.table(m, R, parent, index);
      default: {
        const kind =
          m.type === 'yaml' || m.type === 'toml'
            ? 'frontmatter'
            : m.type === 'html' ||
                m.type === 'definition' ||
                m.type === 'footnoteDefinition' ||
                m.type === 'math'
              ? m.type
              : m.type;
        const label =
          m.type === 'definition' || m.type === 'footnoteDefinition'
            ? normalizeLabel(String(m.identifier ?? m.label ?? ''))
            : null;
        const o = this.origin(m, 'rawBlock', R, parent, index);
        return (o.node = schema.nodes.rawBlock!.create({
          sid: o.sid,
          source: dedentLines(src.slice(s, e), R),
          kind,
          label,
        }));
      }
    }
  }

  private list(m: MNode, R: string, parent: Origin | null, index: number): PMNode {
    const { schema, src } = this;
    const ordered = m.ordered === true;
    const o = this.origin(m, ordered ? 'orderedList' : 'bulletList', R, parent, index);
    const items = m.children ?? [];
    const markers = items.map((item) => {
      const at = this.start(item);
      if (!ordered) return src[at] ?? '-';
      return /^\d{1,9}[.)]/.exec(src.slice(at, at + 10))?.[0] ?? '1.';
    });
    o.indent = items.length > 0 ? Math.max(0, this.col(this.start(items[0]!)) - R.length) : 0;
    const tight = m.spread !== true;
    let attrs: Record<string, unknown>;
    if (ordered) {
      const numbers = markers.map((marker) => parseInt(marker, 10));
      const first = numbers[0] ?? 1;
      o.numbering = numbers.every((n, i) => n === first + i)
        ? 'sequential'
        : numbers.every((n) => n === first)
          ? 'same'
          : 'free';
      const delimiter = markers[0]?.slice(-1) ?? '.';
      attrs = { sid: o.sid, start: (m.start as number | null) ?? first, delimiter, tight };
    } else {
      const bullet = markers[0] ?? '-';
      this.style.bullet.add(bullet);
      attrs = { sid: o.sid, bullet, tight };
    }
    const content = items.map((item, i) => this.listItem(item, markers[i]!, R, o, i));
    const type = ordered ? schema.nodes.orderedList! : schema.nodes.bulletList!;
    return (o.node = type.create(attrs, content));
  }

  private listItem(m: MNode, marker: string, R: string, parent: Origin, index: number): PMNode {
    const { schema, src } = this;
    const o = this.origin(m, 'listItem', R, parent, index);
    const s = o.start;
    const markerEnd = s + marker.length;
    const lineEnd = lineEndOf(src, s);
    let sp = markerEnd;
    while (sp < lineEnd && (src[sp] === ' ' || src[sp] === '\t')) sp++;
    const children = m.children ?? [];
    const first = children[0];
    const sameLine = first !== undefined && lineStartOf(src, this.start(first)) === lineStartOf(src, s);
    const spacing = this.col(sp) - this.col(markerEnd);
    const contentCol =
      !sameLine || sp >= lineEnd || spacing > 4 ? this.col(markerEnd) + 1 : this.col(sp);
    o.indent = Math.max(0, this.col(s) - R.length);
    o.innerR = R + spaces(contentCol - R.length);
    o.markerText = marker;
    o.head = first ? src.slice(s, this.start(first)) : src.slice(s, o.end);
    const content = children.map((child, i) => this.block(child, o.innerR, o, i));
    if (content.length === 0) content.push(this.emptyParagraph());
    const checked = typeof m.checked === 'boolean' ? m.checked : null;
    return (o.node = schema.nodes.listItem!.create({ sid: o.sid, checked }, content));
  }

  private code(m: MNode, R: string, parent: Origin | null, index: number): PMNode {
    const { schema, src } = this;
    const o = this.origin(m, 'codeBlock', R, parent, index);
    const s = o.start;
    const e = o.end;
    const value = String(m.value ?? '');
    const valueLines = value === '' ? 0 : value.split('\n').length;
    const fenceMatch = /^(`{3,}|~{3,})/.exec(src.slice(s, s + 100));
    let attrs: Record<string, unknown>;
    if (fenceMatch) {
      const fence = fenceMatch[1]!;
      this.style.fence.add(fence[0] === '`' ? '```' : '~~~');
      const openEnd = Math.min(lineEndOf(src, s), e);
      o.openLine = src.slice(s, openEnd);
      const spans: Array<{ start: number; end: number }> = [];
      for (let p = openEnd; p < e; ) {
        const ls = p + 1;
        const le = Math.min(lineEndOf(src, ls), e);
        spans.push({ start: ls, end: le });
        p = le;
      }
      o.closeLine = null;
      const last = spans[spans.length - 1];
      if (last) {
        const line = dedentLines('\n' + src.slice(last.start, last.end), R).slice(1).trimStart();
        const close = /^(`{3,}|~{3,})[ \t]*$/.exec(line);
        if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) {
          o.closeLine = spans.pop()!;
        }
      }
      o.bodyLines = spans.length === valueLines ? spans : undefined;
      o.fenceIndent = Math.max(0, this.col(s) - R.length);
      attrs = {
        sid: o.sid,
        language: (m.lang as string | null) ?? null,
        meta: (m.meta as string | null) ?? null,
        fence,
        indented: false,
      };
    } else {
      // Indented code: the block starts at the indentation (after the container prefix) so that
      // the gap before it never contains the code indentation.
      let p = lineStartOf(src, s);
      if (src.startsWith(R, p)) p += R.length;
      else if (R.trimEnd() && src.startsWith(R.trimEnd(), p)) p += R.trimEnd().length;
      if (p > s) p = s;
      o.start = p;
      const spans: Array<{ start: number; end: number }> = [];
      for (let ls = p; ls <= e; ) {
        const le = Math.min(lineEndOf(src, ls), e);
        spans.push({ start: ls, end: le });
        ls = le + 1;
      }
      o.bodyLines = spans.length === valueLines ? spans : undefined;
      o.fenceIndent = 0;
      attrs = { sid: o.sid, language: null, meta: null, fence: null, indented: true };
    }
    return (o.node = schema.nodes.codeBlock!.create(attrs, value ? schema.text(value) : null));
  }

  private table(m: MNode, R: string, parent: Origin | null, index: number): PMNode {
    const { schema, src } = this;
    const o = this.origin(m, 'table', R, parent, index);
    const align = (m.align as Array<string | null> | undefined) ?? [];
    const rows = m.children ?? [];
    const columns = Math.max(align.length, ...rows.map((row) => row.children?.length ?? 0));
    if (rows.length > 0) {
      const ls = this.end(rows[0]!) + 1;
      const line = src.slice(ls, lineEndOf(src, ls));
      o.delimLine = dedentLines('\n' + line, R).slice(1);
    }
    const content = rows.map((row, ri) => {
      const ro = this.origin(row, 'tableRow', R, o, ri);
      const cells = row.children ?? [];
      ro.cellCount = cells.length;
      const nodes = cells.map((cell, ci) => this.cell(cell, ri === 0, align[ci] ?? null, R, ro, ci));
      for (let ci = cells.length; ci < columns; ci++) {
        const type = ri === 0 ? schema.nodes.tableHeader! : schema.nodes.tableCell!;
        nodes.push(type.create({ align: align[ci] ?? null }));
      }
      return (ro.node = schema.nodes.tableRow!.create({ sid: ro.sid }, nodes));
    });
    return (o.node = schema.nodes.table!.create({ sid: o.sid }, content));
  }

  private cell(m: MNode, header: boolean, align: string | null, R: string, parent: Origin, index: number): PMNode {
    const { schema, src } = this;
    const type = header ? 'tableHeader' : 'tableCell';
    const o = this.origin(m, type, R, parent, index);
    const children = m.children ?? [];
    let nodes: PMNode[] = [];
    if (children.length > 0) {
      const cs = this.start(children[0]!);
      const ce = this.end(children[children.length - 1]!);
      o.contentStart = cs;
      o.contentEnd = ce;
      o.contentAtLineStart = false;
      const acc = this.inlines(children, cs, ce);
      o.units = acc.units;
      o.points = acc.points;
      nodes = acc.nodes;
    } else {
      let p = o.start;
      if (src[p] === '|') p++;
      if (src[p] === ' ' && p < o.end) p++;
      o.emptyInsert = p;
    }
    return (o.node = schema.nodes[type]!.create({ sid: o.sid, align }, nodes));
  }

  // ---------------------------------------------------------------- inline content

  private inlines(children: MNode[], contentStart: number, contentEnd: number): InlineAcc {
    const acc: InlineAcc = { nodes: [], units: [], points: [{ pos: 0, src: contentStart }], pos: 0 };
    children.forEach((child, i) => {
      this.inline(child, [], true, acc);
      const next = children[i + 1];
      acc.points.push({ pos: acc.pos, src: next ? this.start(next) : contentEnd });
    });
    return acc;
  }

  private push(acc: InlineAcc, node: PMNode, unit: Omit<Unit, 'from' | 'to'>): void {
    acc.nodes.push(node);
    acc.units.push({ ...unit, from: acc.pos, to: acc.pos + node.nodeSize });
    acc.pos += node.nodeSize;
  }

  private raw(m: MNode, kind: string, marks: readonly Mark[], acc: InlineAcc, label: string | null = null): void {
    const s = this.start(m);
    const e = this.end(m);
    const node = this.schema.nodes.rawInline!.create({ source: this.src.slice(s, e), kind, label }, null, marks);
    this.push(acc, node, { srcFrom: s, srcTo: e, kind: 'atom', map: null });
  }

  private inline(m: MNode, marks: readonly Mark[], top: boolean, acc: InlineAcc): void {
    const { schema, src } = this;
    const s = this.start(m);
    const e = this.end(m);
    const children = m.children ?? [];
    const withMark = (mark: Mark) => {
      const set = mark.addToSet(marks);
      for (const child of children) this.inline(child, set, false, acc);
    };
    switch (m.type) {
      case 'text':
        this.text(m, marks, top, acc);
        return;
      case 'emphasis': {
        const marker = src[s] === '_' ? '_' : '*';
        this.style.emphasis.add(marker);
        withMark(schema.marks.italic!.create({ marker }));
        return;
      }
      case 'strong': {
        const marker = src[s] === '_' ? '__' : '**';
        this.style.strong.add(marker);
        withMark(schema.marks.bold!.create({ marker }));
        return;
      }
      case 'delete':
        withMark(schema.marks.strike!.create({ marker: src[s + 1] === '~' ? '~~' : '~' }));
        return;
      case 'inlineCode': {
        const value = String(m.value ?? '');
        if (!value) {
          this.raw(m, 'code', marks, acc);
          return;
        }
        let fence = 0;
        while (src[s + fence] === '`') fence++;
        const inner = src.slice(s + fence, e - fence);
        let base = -1;
        if (inner === value) base = s + fence;
        else if (inner.length === value.length + 2 && inner[0] === ' ' && inner.endsWith(' ') && inner.slice(1, -1) === value) {
          base = s + fence + 1;
        }
        const map = base < 0 ? null : Array.from({ length: value.length + 1 }, (_, k) => base + k);
        const node = schema.text(value, schema.marks.code!.create().addToSet(marks));
        this.push(acc, node, { srcFrom: s, srcTo: e, kind: 'code', map });
        return;
      }
      case 'break': {
        const raw = src.slice(s, e);
        const marker = raw.startsWith('\\') ? '\\' : (raw.split('\n')[0] ?? '  ');
        this.style.hardBreak.add(marker.startsWith('\\') ? '\\' : '  ');
        const node = schema.nodes.hardBreak!.create({ marker }, null, marks);
        this.push(acc, node, { srcFrom: s, srcTo: e, kind: 'atom', map: null });
        return;
      }
      case 'link': {
        if (children.length === 0) {
          this.raw(m, 'link', marks, acc);
          return;
        }
        const autolink = src[s] === '<' ? 'angle' : src[s] === '[' ? null : 'literal';
        withMark(
          schema.marks.link!.create({
            href: String(m.url ?? ''),
            title: (m.title as string | null) ?? null,
            autolink,
          }),
        );
        return;
      }
      case 'linkReference': {
        const def = this.definitions.get(normalizeLabel(String(m.identifier ?? '')));
        if (!def || children.length === 0) {
          this.raw(m, 'linkReference', marks, acc);
          return;
        }
        withMark(
          schema.marks.link!.create({
            href: def.url,
            title: def.title,
            refType: m.referenceType as string,
            refLabel: (m.label as string | undefined) ?? null,
          }),
        );
        return;
      }
      case 'image': {
        const node = schema.nodes.image!.create(
          { src: String(m.url ?? ''), alt: String(m.alt ?? ''), title: (m.title as string | null) ?? null },
          null,
          marks,
        );
        this.push(acc, node, { srcFrom: s, srcTo: e, kind: 'atom', map: null });
        return;
      }
      case 'imageReference': {
        const def = this.definitions.get(normalizeLabel(String(m.identifier ?? '')));
        if (!def) {
          this.raw(m, 'imageReference', marks, acc);
          return;
        }
        const node = schema.nodes.image!.create(
          {
            src: def.url,
            alt: String(m.alt ?? ''),
            title: def.title,
            refType: m.referenceType as string,
            refLabel: (m.label as string | undefined) ?? null,
          },
          null,
          marks,
        );
        this.push(acc, node, { srcFrom: s, srcTo: e, kind: 'atom', map: null });
        return;
      }
      case 'footnoteReference':
        this.raw(m, 'footnoteReference', marks, acc, normalizeLabel(String(m.identifier ?? '')));
        return;
      case 'inlineMath':
        this.raw(m, 'math', marks, acc);
        return;
      default:
        this.raw(m, m.type, marks, acc);
    }
  }

  private text(m: MNode, marks: readonly Mark[], top: boolean, acc: InlineAcc): void {
    const { schema, src } = this;
    const value = String(m.value ?? '');
    if (!value) return;
    const s = this.start(m);
    const e = this.end(m);
    const map = alignText(src, s, e, value);
    const pieces: Array<{ a: number; b: number; wiki: boolean }> = [];
    let last = 0;
    if (map) {
      for (const match of value.matchAll(WIKILINK_RE)) {
        const a = match.index;
        const b = a + match[0].length;
        if (map[a]! >= 0 && map[b]! >= 0 && src.slice(map[a], map[b]) === match[0]) {
          if (a > last) pieces.push({ a: last, b: a, wiki: false });
          pieces.push({ a, b, wiki: true });
          last = b;
        }
      }
    }
    if (last < value.length) pieces.push({ a: last, b: value.length, wiki: false });
    pieces.forEach((piece, i) => {
      if (piece.wiki) {
        const source = value.slice(piece.a, piece.b);
        const node = schema.nodes.rawInline!.create({ source, kind: 'wikilink', label: null }, null, marks);
        this.push(acc, node, { srcFrom: map![piece.a]!, srcTo: map![piece.b]!, kind: 'atom', map: null });
      } else {
        const startPos = acc.pos;
        const node = schema.text(value.slice(piece.a, piece.b), marks);
        const sub = map ? map.slice(piece.a, piece.b + 1) : null;
        this.push(acc, node, {
          srcFrom: sub ? sub[0]! : s,
          srcTo: sub ? sub[sub.length - 1]! : e,
          kind: 'text',
          map: sub,
        });
        if (top && sub) {
          for (let k = 1; k < sub.length - 1; k++) {
            if (sub[k]! >= 0) acc.points.push({ pos: startPos + k, src: sub[k]! });
          }
        }
      }
      if (top && map && i < pieces.length - 1) acc.points.push({ pos: acc.pos, src: map[piece.b]! });
    });
  }
}

/** Parse Markdown (LF line endings) into a ProseMirror document plus its source map. */
export function parseMarkdown(text: string, schema: Schema): ParseResult {
  return new Parser(text, schema).parse();
}
