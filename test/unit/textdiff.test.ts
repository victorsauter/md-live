import { describe, expect, it } from 'vitest';
import { applyEdits, computeEdits, mergeEdits } from '../../shared/textdiff';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ALPHABET = ['a', 'b', 'c', ' ', '\n', '\r\n', '#', '-', 'é', '😀', '|', '\t'];

function randomText(r: () => number, len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(r() * ALPHABET.length)];
  return out;
}

function mutate(r: () => number, text: string): string {
  const chars = Array.from(text);
  const ops = 1 + Math.floor(r() * 4);
  for (let i = 0; i < ops; i++) {
    const pos = Math.floor(r() * (chars.length + 1));
    const kind = r();
    if (kind < 0.33) chars.splice(pos, 0, ...Array.from(randomText(r, 1 + Math.floor(r() * 5))));
    else if (kind < 0.66) chars.splice(pos, 1 + Math.floor(r() * 3));
    else chars.splice(pos, 1, ...Array.from(randomText(r, 1)));
  }
  return chars.join('');
}

describe('computeEdits', () => {
  it('returns no edits for identical text', () => {
    expect(computeEdits('abc\n', 'abc\n')).toEqual([]);
  });

  it('round-trips random changes (property test)', () => {
    const r = rng(42);
    for (let i = 0; i < 2000; i++) {
      const a = randomText(r, Math.floor(r() * 60));
      const b = r() < 0.2 ? randomText(r, Math.floor(r() * 60)) : mutate(r, a);
      const edits = computeEdits(a, b);
      expect(applyEdits(a, edits)).toBe(b);
      for (let j = 1; j < edits.length; j++) expect(edits[j].start).toBeGreaterThanOrEqual(edits[j - 1].end);
    }
  });

  it('never splits surrogate pairs', () => {
    const edits = computeEdits('x😀y', 'x😃y');
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toBe('😃');
  });

  it('confines a one-word change to its line', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} with some words`);
    const a = lines.join('\n') + '\n';
    const b = a.replace('line 25 with some', 'line 25 with many');
    const edits = computeEdits(a, b);
    expect(edits).toHaveLength(1);
    const startLine = a.slice(0, edits[0].start).split('\n').length;
    const endLine = a.slice(0, edits[0].end).split('\n').length;
    expect(startLine).toBe(26);
    expect(endLine).toBe(26);
  });

  it('keeps distant edits separate', () => {
    const a = 'one\ntwo\nthree\nfour\nfive\n';
    const b = 'ONE\ntwo\nthree\nfour\nFIVE\n';
    const edits = computeEdits(a, b);
    expect(edits.length).toBe(2);
    expect(applyEdits(a, edits)).toBe(b);
  });
});

describe('mergeEdits', () => {
  it('merges non-overlapping edits', () => {
    const base = 'aaa\nbbb\nccc\n';
    const ours = computeEdits(base, 'AAA\nbbb\nccc\n');
    const theirs = computeEdits(base, 'aaa\nbbb\nCCC\n');
    const merged = mergeEdits(base, ours, theirs);
    expect(merged).not.toBeNull();
    expect(applyEdits(base, merged!)).toBe('AAA\nbbb\nCCC\n');
  });

  it('rejects overlapping edits', () => {
    const base = 'aaa\nbbb\n';
    expect(mergeEdits(base, computeEdits(base, 'aXa\nbbb\n'), computeEdits(base, 'aYa\nbbb\n'))).toBeNull();
  });
});
