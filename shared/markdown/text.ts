/** Small text helpers shared by the parser and the serializer. */

export function isAsciiPunct(ch: string | undefined): boolean {
  if (!ch || ch.length !== 1) return false;
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

export function isWhitespace(ch: string | undefined): boolean {
  return ch === undefined || ch === '' || /\s/.test(ch);
}

export function isAlnum(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}]/u.test(ch);
}

export function spaces(n: number): string {
  return n > 0 ? ' '.repeat(n) : '';
}

export function lineStartOf(text: string, offset: number): number {
  return offset <= 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1;
}

export function lineEndOf(text: string, offset: number): number {
  const i = text.indexOf('\n', offset);
  return i === -1 ? text.length : i;
}

/** Visual column of `offset` (tabs expand to the next multiple of 4). */
export function columnOf(text: string, offset: number): number {
  let col = 0;
  for (let i = lineStartOf(text, offset); i < offset; i++) {
    col = text[i] === '\t' ? col + 4 - (col % 4) : col + 1;
  }
  return col;
}

/** Prefix lines 2..n of `text` with `prefix` (blank lines get the trimmed prefix). */
export function indentLines(text: string, prefix: string): string {
  if (!prefix || !text.includes('\n')) return text;
  const blank = prefix.trimEnd();
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? line : line === '' ? blank : prefix + line))
    .join('\n');
}

/**
 * Remove `prefix` from lines 2..n. Lines that are blank or only contain the trimmed prefix become
 * empty; other lines without the prefix (lazy continuation) are kept as they are.
 */
export function dedentLines(text: string, prefix: string): string {
  if (!prefix || !text.includes('\n')) return text;
  const blank = prefix.trimEnd();
  return text
    .split('\n')
    .map((line, i) => {
      if (i === 0) return line;
      if (line.startsWith(prefix)) return line.slice(prefix.length);
      if (line.trimEnd() === blank || line.trim() === '') return '';
      return line;
    })
    .join('\n');
}

/** Re-prefix a slice written for continuation prefix `from` so that it fits `to`. */
export function reprefix(text: string, from: string, to: string): string {
  if (from === to) return text;
  return indentLines(dedentLines(text, from), to);
}
