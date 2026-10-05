/**
 * Minimal text diff used to turn a full-text update into small replacements.
 *
 * Offsets are UTF-16 code unit offsets into the *old* text. Edits are sorted and non-overlapping.
 */

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

const MAX_DIFF_LINES = 4000;

function commonPrefix(a: string, b: string, aStart = 0, bStart = 0, aEnd = a.length, bEnd = b.length): number {
  let i = 0;
  const max = Math.min(aEnd - aStart, bEnd - bStart);
  while (i < max && a.charCodeAt(aStart + i) === b.charCodeAt(bStart + i)) i++;
  return i;
}

function commonSuffix(a: string, b: string, aStart: number, bStart: number, aEnd: number, bEnd: number): number {
  let i = 0;
  const max = Math.min(aEnd - aStart, bEnd - bStart);
  while (i < max && a.charCodeAt(aEnd - 1 - i) === b.charCodeAt(bEnd - 1 - i)) i++;
  return i;
}

/** Avoid splitting a surrogate pair at an edit boundary. */
function adjustPrefix(text: string, n: number): number {
  if (n > 0 && n < text.length) {
    const c = text.charCodeAt(n - 1);
    if (c >= 0xd800 && c <= 0xdbff) return n - 1;
  }
  return n;
}

function splitLines(text: string, start: number, end: number): { starts: number[]; lines: string[] } {
  const starts: number[] = [];
  const lines: string[] = [];
  let pos = start;
  while (pos <= end) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 || nl >= end ? end : nl + 1;
    starts.push(pos);
    lines.push(text.slice(pos, lineEnd));
    if (lineEnd >= end) break;
    pos = lineEnd;
  }
  return { starts, lines };
}

/** Myers diff on line arrays; returns matched pairs [aIndex, bIndex] in increasing order. */
function diffLines(a: string[], b: string[]): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  const offset = max + 1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        // Backtrack.
        const pairs: Array<[number, number]> = [];
        let cx = n;
        let cy = m;
        for (let dd = d; dd > 0; dd--) {
          const vv = trace[dd];
          const kk = cx - cy;
          let prevK: number;
          if (kk === -dd || (kk !== dd && vv[offset + kk - 1] < vv[offset + kk + 1])) prevK = kk + 1;
          else prevK = kk - 1;
          const prevX = vv[offset + prevK];
          const prevY = prevX - prevK;
          while (cx > prevX && cy > prevY) {
            pairs.push([cx - 1, cy - 1]);
            cx--;
            cy--;
          }
          cx = prevX;
          cy = prevY;
        }
        while (cx > 0 && cy > 0) {
          pairs.push([cx - 1, cy - 1]);
          cx--;
          cy--;
        }
        return pairs.reverse();
      }
    }
    if (d > 2000) return null;
  }
  return null;
}

function trimEdit(oldText: string, newText: string, oStart: number, oEnd: number, nStart: number, nEnd: number): TextEdit | null {
  const p = adjustPrefix(oldText, commonPrefix(oldText, newText, oStart, nStart, oEnd, nEnd) + oStart) - oStart;
  let s = commonSuffix(oldText, newText, oStart + p, nStart + p, oEnd, nEnd);
  if (s > 0) {
    const c = oldText.charCodeAt(oEnd - s);
    if (c >= 0xdc00 && c <= 0xdfff) s--;
  }
  const start = oStart + p;
  const end = oEnd - s;
  const text = newText.slice(nStart + p, nEnd - s);
  if (start === end && text === '') return null;
  return { start, end, text };
}

/**
 * Compute a small set of edits transforming `oldText` into `newText`.
 * Unchanged lines are never touched.
 */
export function computeEdits(oldText: string, newText: string): TextEdit[] {
  if (oldText === newText) return [];
  const prefix = adjustPrefix(oldText, commonPrefix(oldText, newText));
  let suffix = commonSuffix(oldText, newText, prefix, prefix, oldText.length, newText.length);
  if (suffix > 0) {
    const c = oldText.charCodeAt(oldText.length - suffix);
    if (c >= 0xdc00 && c <= 0xdfff) suffix--;
  }
  const oEnd = oldText.length - suffix;
  const nEnd = newText.length - suffix;
  // Expand to full lines for the line diff.
  const lineStart = prefix === 0 ? 0 : oldText.lastIndexOf('\n', prefix - 1) + 1;
  const oLineEndIdx = oldText.indexOf('\n', oEnd);
  const oLineEnd = oLineEndIdx === -1 ? oldText.length : oLineEndIdx + 1;
  const nLineEnd = oLineEnd - oEnd + nEnd;
  if (nLineEnd > newText.length) {
    const single = trimEdit(oldText, newText, prefix, oEnd, prefix, nEnd);
    return single ? [single] : [];
  }
  const a = splitLines(oldText, lineStart, oLineEnd);
  const b = splitLines(newText, lineStart, nLineEnd);
  if (a.lines.length + b.lines.length > MAX_DIFF_LINES || (a.lines.length <= 1 && b.lines.length <= 1)) {
    const single = trimEdit(oldText, newText, prefix, oEnd, prefix, nEnd);
    return single ? [single] : [];
  }
  const pairs = diffLines(a.lines, b.lines);
  if (!pairs) {
    const single = trimEdit(oldText, newText, prefix, oEnd, prefix, nEnd);
    return single ? [single] : [];
  }
  const edits: TextEdit[] = [];
  let ai = 0;
  let bi = 0;
  const lineOffset = (lines: { starts: number[] }, idx: number, end: number) =>
    idx < lines.starts.length ? lines.starts[idx] : end;
  for (const [pa, pb] of [...pairs, [a.lines.length, b.lines.length] as [number, number]]) {
    if (pa > ai || pb > bi) {
      const os = lineOffset(a, ai, oLineEnd);
      const oe = lineOffset(a, pa, oLineEnd);
      const ns = lineOffset(b, bi, nLineEnd);
      const ne = lineOffset(b, pb, nLineEnd);
      const edit = trimEdit(oldText, newText, os, oe, ns, ne);
      if (edit) edits.push(edit);
    }
    ai = pa + 1;
    bi = pb + 1;
  }
  return edits;
}

/** Apply edits (sorted, non-overlapping, offsets in the original text). */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = '';
  let pos = 0;
  for (const e of edits) {
    out += text.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + text.slice(pos);
}

/**
 * Three-way merge of two edit sets made against the same base. Returns null when edits overlap.
 */
export function mergeEdits(base: string, ours: readonly TextEdit[], theirs: readonly TextEdit[]): TextEdit[] | null {
  const all = [...ours.map((e) => ({ ...e, side: 0 })), ...theirs.map((e) => ({ ...e, side: 1 }))].sort(
    (x, y) => x.start - y.start || x.end - y.end,
  );
  for (let i = 1; i < all.length; i++) {
    const prev = all[i - 1];
    const cur = all[i];
    if (cur.start < prev.end || (cur.start === prev.start && prev.side !== cur.side)) return null;
  }
  void base;
  return all.map(({ start, end, text }) => ({ start, end, text }));
}
