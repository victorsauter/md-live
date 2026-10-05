/**
 * Alignment between the decoded value of an mdast `text` node and its Markdown source.
 *
 * mdast text values are decoded (escapes and character references resolved, line prefixes and
 * trailing whitespace before line endings removed). To patch a single word inside a long paragraph
 * without touching the rest of the source, we need to know where each value character comes from.
 */
import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import { isAsciiPunct } from './text';

const ENTITY_RE = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/y;

/** Decode the character reference starting at `offset`, if any. */
export function matchEntity(src: string, offset: number): { length: number; value: string } | null {
  ENTITY_RE.lastIndex = offset;
  const m = ENTITY_RE.exec(src);
  if (!m) return null;
  let value: string | false;
  if (m[1] !== undefined || m[2] !== undefined) {
    const code = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2]!, 16);
    value = code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(code);
  } else {
    value = decodeNamedCharacterReference(m[3]!);
  }
  return value === false ? null : { length: m[0].length, value };
}

/** Is there a character reference (that a parser would decode) at `offset`? */
export function isEntityAt(text: string, offset: number): boolean {
  return matchEntity(text, offset) !== null;
}

/**
 * Map every boundary of `value` to a source offset in `src[start, end)`.
 *
 * Returns an array of length `value.length + 1`; `map[k]` is the source offset of the boundary
 * before value character `k` (`-1` when the boundary falls inside a multi-character unit such as an
 * entity). For a line ending, the boundary before `\n` points at the stripped trailing whitespace
 * and the boundary after it points after the next line's container prefix. Returns `null` when the
 * value cannot be aligned unambiguously.
 */
export function alignText(src: string, start: number, end: number, value: string): number[] | null {
  const map = new Array<number>(value.length + 1);
  let i = start;
  let k = 0;
  while (k < value.length) {
    const c = value[k]!;
    if (c === '\n') {
      map[k] = i;
      let j = i;
      while (j < end && (src[j] === ' ' || src[j] === '\t')) j++;
      if (src[j] !== '\n') return null;
      j++;
      while (j < end && (src[j] === ' ' || src[j] === '\t' || src[j] === '>')) j++;
      i = j;
      k++;
      continue;
    }
    if (i >= end) return null;
    const s = src[i]!;
    if (s === c && s !== '\\' && s !== '&') {
      map[k++] = i++;
      continue;
    }
    if (s === '\\') {
      const n = src[i + 1];
      if (n !== undefined && isAsciiPunct(n) && n === c) {
        map[k++] = i;
        i += 2;
        continue;
      }
      if (c === '\\') {
        map[k++] = i++;
        continue;
      }
      return null;
    }
    if (s === '&') {
      const entity = matchEntity(src, i);
      if (entity && value.startsWith(entity.value, k)) {
        map[k] = i;
        for (let m = 1; m < entity.value.length; m++) map[k + m] = -1;
        k += entity.value.length;
        i += entity.length;
        continue;
      }
      if (c === '&') {
        map[k++] = i++;
        continue;
      }
      return null;
    }
    return null;
  }
  if (i !== end) return null;
  map[value.length] = i;
  return map;
}
