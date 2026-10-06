import { describe, expect, it } from 'vitest';
import { getMarkdownSchema } from '../../shared/markdown/schema';
import { findMatches } from '../../webview/src/editor/find';

function document(content: object[]) {
  return getMarkdownSchema().nodeFromJSON({ type: 'doc', content });
}

function textAt(doc: ReturnType<typeof document>, match: { from: number; to: number }) {
  return doc.textBetween(match.from, match.to);
}

describe('Live editor find matching', () => {
  it('matches case-insensitively by default and respects Match Case', () => {
    const doc = document([{ type: 'paragraph', content: [{ type: 'text', text: 'Marklive marklive' }] }]);
    expect(findMatches(doc, 'MARKLIVE').matches.map((match) => textAt(doc, match))).toEqual(['Marklive', 'marklive']);
    expect(findMatches(doc, 'MARKLIVE', { caseSensitive: true, wholeWord: false, regex: false }).matches).toEqual([]);
  });

  it('matches whole words with Unicode letters and digits', () => {
    const doc = document([{ type: 'paragraph', content: [{ type: 'text', text: 'Été été2 _été_ été.' }] }]);
    const result = findMatches(doc, 'été', { caseSensitive: false, wholeWord: true, regex: false });
    expect(result.matches.map((match) => textAt(doc, match))).toEqual(['Été', 'été']);
  });

  it('supports regular expressions and reports invalid or empty expressions safely', () => {
    const doc = document([{ type: 'paragraph', content: [{ type: 'text', text: 'abc abc' }] }]);
    const regex = findMatches(doc, 'a.c', { caseSensitive: false, wholeWord: false, regex: true });
    expect(regex.matches.map((match) => textAt(doc, match))).toEqual(['abc', 'abc']);
    expect(findMatches(doc, '(', { caseSensitive: false, wholeWord: false, regex: true })).toMatchObject({
      matches: [],
      error: expect.any(String),
    });
    expect(findMatches(doc, '', { caseSensitive: false, wholeWord: false, regex: true })).toEqual({ matches: [], error: null });
    expect(findMatches(doc, '(?=.)', { caseSensitive: false, wholeWord: false, regex: true })).toEqual({ matches: [], error: null });
  });

  it('preserves offsets for Unicode accents in case-insensitive matches', () => {
    const doc = document([{ type: 'paragraph', content: [{ type: 'text', text: 'İ ÉTÉ and été' }] }]);
    const result = findMatches(doc, 'été');
    expect(result.matches.map((match) => textAt(doc, match))).toEqual(['ÉTÉ', 'été']);
  });

  it('matches across adjacent text nodes with different marks', () => {
    const doc = document([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Aero', marks: [{ type: 'bold' }] },
          { type: 'text', text: 'spike', marks: [{ type: 'italic' }] },
        ],
      },
    ]);
    const result = findMatches(doc, 'Aerospike');
    expect(result.matches).toHaveLength(1);
    expect(textAt(doc, result.matches[0]!)).toBe('Aerospike');
  });

  it('does not join text across inline atoms', () => {
    const doc = document([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Aero' },
          { type: 'rawInline', attrs: { source: '{{hidden}}', kind: 'html' } },
          { type: 'text', text: 'spike' },
        ],
      },
    ]);
    expect(findMatches(doc, 'Aerospike').matches).toEqual([]);
  });

  it('searches table cells and code blocks as independent textblocks', () => {
    const doc = document([
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [{ type: 'text', text: 'needle in table' }] },
              { type: 'tableCell', content: [{ type: 'text', text: 'another needle' }] },
            ],
          },
        ],
      },
      { type: 'codeBlock', content: [{ type: 'text', text: 'needle in code' }] },
    ]);
    const result = findMatches(doc, 'needle');
    expect(result.matches.map((match) => textAt(doc, match))).toEqual(['needle', 'needle', 'needle']);
  });
});
