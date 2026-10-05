/** Escaping of plain text spliced into existing Markdown source. */
import { isEntityAt } from './align';
import { isAlnum, isAsciiPunct, isWhitespace } from './text';

export type InlineKind = 'paragraph' | 'heading' | 'cell';

export interface EscapeContext {
  /** Source text before the insertion point on the same line (including container prefixes). */
  before: string;
  /** Source text after the insertion point on the same line. */
  after: string;
  /** Whether the insertion point is at the start of a line (block constructs could start there). */
  lineStart: boolean;
  kind: InlineKind;
  /** Continuation prefix used when the text contains line breaks. */
  R: string;
}

const WIKILINK_RE = /\[\[[^[\]\n]+\]\]/g;

/**
 * Escape `text` so that, once inserted between `before` and `after`, it is parsed back as the same
 * literal text. The rules are conservative (escaping an ASCII punctuation character never changes
 * the rendered text); the serializer verifies the result anyway.
 */
export function escapeText(text: string, ctx: EscapeContext): string {
  if (ctx.kind !== 'paragraph') text = text.replace(/\n/g, ' ');
  const full = ctx.before + text + ctx.after;
  const base = ctx.before.length;
  const protectedRanges: Array<[number, number]> = [];
  for (const match of full.matchAll(WIKILINK_RE)) protectedRanges.push([match.index, match.index + match[0].length]);
  const isProtected = (i: number) => protectedRanges.some(([a, b]) => i >= a && i < b);
  const forced = new Set<number>();
  let out = '';
  let lineStart = ctx.lineStart;
  for (let k = 0; k < text.length; k++) {
    const i = base + k;
    const c = text[k]!;
    const prev = i > 0 ? full[i - 1] : undefined;
    const next = full[i + 1];
    if (c === '\n') {
      out = out.replace(/[ \t]+$/, '') + '\n' + ctx.R;
      lineStart = true;
      continue;
    }
    if (lineStart && (c === ' ' || c === '\t')) continue;
    let escape = false;
    switch (c) {
      case '\\':
        escape = next === undefined || next === '\n' || isAsciiPunct(next);
        break;
      case '*':
        escape = !(isWhitespace(prev) && isWhitespace(next)) || lineStart;
        break;
      case '_':
        escape = !((isAlnum(prev) && isAlnum(next)) || (isWhitespace(prev) && isWhitespace(next))) || lineStart;
        break;
      case '~':
        escape = !(isWhitespace(prev) && isWhitespace(next));
        break;
      case '`':
        escape = true;
        break;
      case '[':
      case ']':
        escape = !isProtected(i);
        break;
      case '<':
        escape = next !== undefined && /[A-Za-z/!?]/.test(next);
        break;
      case '&':
        escape = isEntityAt(full, i);
        break;
      case '|':
        escape = ctx.kind === 'cell';
        break;
      case '$':
        escape = (full.match(/\$/g)?.length ?? 0) > 1;
        break;
      case '#':
        escape = lineStart || (ctx.kind === 'heading' && /^#*[ \t]*$/.test(full.slice(i + 1)));
        break;
      case '>':
      case '-':
      case '+':
      case '=':
        escape = lineStart;
        break;
      case '!':
        escape = next === '[';
        break;
      default:
        if (lineStart && c >= '0' && c <= '9') {
          let j = i;
          while (j < full.length && full[j]! >= '0' && full[j]! <= '9') j++;
          if (full[j] === '.' || full[j] === ')') forced.add(j);
        }
    }
    if (forced.has(i)) escape = true;
    out += escape ? '\\' + c : c;
    lineStart = false;
  }
  if (ctx.after === '' || ctx.after.startsWith('\n')) out = out.replace(/[ \t]+$/, '');
  return out;
}
