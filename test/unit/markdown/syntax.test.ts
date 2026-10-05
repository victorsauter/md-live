import { describe, expect, it } from 'vitest';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { parseMarkdown } from '../../../shared/markdown/parse';
import { syntaxMarkers, type SyntaxMarker } from '../../../shared/markdown/syntax';
import { find, schema } from './helpers';

function stateAt(text: string, needle: string, offset = 0, to?: string): EditorState {
  const { doc } = parseMarkdown(text, schema);
  const anchor = find(doc, needle).from + offset;
  const head = to === undefined ? anchor : find(doc, to).to;
  return EditorState.create({ doc, selection: TextSelection.create(doc, anchor, head) });
}

/** Renders the textblock(s) with the markers inserted, `|` marking the cursor. */
function reveal(state: EditorState, markers: SyntaxMarker[] = syntaxMarkers(state)): string {
  const { from, empty } = state.selection;
  const inserts = markers.map((m) => ({ pos: m.pos, side: m.side, text: m.block ? `\n${m.text}` : m.text }));
  if (empty) inserts.push({ pos: from, side: 0, text: '|' });
  inserts.sort((a, b) => a.pos - b.pos || a.side - b.side);
  let out = '';
  let last = 0;
  const textAt = (from: number, to: number) => state.doc.textBetween(from, to, '\n', '\uFFFC');
  for (const insert of inserts) {
    out += textAt(last, insert.pos) + insert.text;
    last = insert.pos;
  }
  return out + textAt(last, state.doc.content.size);
}

describe('syntax reveal markers', () => {
  it('reveals bold markers around the element under the cursor', () => {
    expect(reveal(stateAt('This is **important**.\n', 'port'))).toBe('This is **im|portant**.');
  });

  it('reveals nothing when the cursor is outside formatted text', () => {
    expect(syntaxMarkers(stateAt('This is **important**.\n', 'This', 2))).toEqual([]);
  });

  it('places the cursor inside or outside the markers like typing does', () => {
    const text = 'This is **important** and [a link](https://x.y).\n';
    expect(reveal(stateAt(text, 'important'))).toBe('This is |**important** and a link.');
    expect(reveal(stateAt(text, 'important', 9))).toBe('This is **important|** and a link.');
    expect(reveal(stateAt(text, 'a link', 6))).toBe('This is important and [a link](https://x.y)|.');
  });

  it('keeps the original markers of the source', () => {
    expect(reveal(stateAt('Some __strong__ and _em_ and ~del~ text\n', 'tro'))).toBe(
      'Some __s|trong__ and em and del text',
    );
    expect(reveal(stateAt('Some __strong__ and _em_ and ~del~ text\n', 'em', 1))).toBe(
      'Some strong and _e|m_ and del text',
    );
    expect(reveal(stateAt('Some __strong__ and _em_ and ~del~ text\n', 'del', 1))).toBe(
      'Some strong and em and ~d|el~ text',
    );
  });

  it('nests markers of overlapping marks', () => {
    expect(reveal(stateAt('A **bold *both* bold** z\n', 'both', 2))).toBe('A **bold *bo|th* bold** z');
    expect(reveal(stateAt('A **a**_b_ z\n', 'a', 1))).toBe('A **a|**_b_ z');
  });

  it('reveals inline code and links', () => {
    expect(reveal(stateAt('Run `npm test` now\n', 'npm', 1))).toBe('Run `n|pm test` now');
    expect(reveal(stateAt('Run ``a ` b`` now\n', 'a', 0))).toBe('Run |`` a ` b `` now');
    expect(reveal(stateAt('See [docs](<./a b.md> "Title") here\n', 'docs', 1))).toBe(
      'See [d|ocs](<./a b.md> "Title") here',
    );
    expect(reveal(stateAt('See [docs][ref].\n\n[ref]: https://x.y\n', 'docs', 1))).toBe(
      'See [d|ocs][ref].\n\uFFFC',
    );
    expect(reveal(stateAt('Go <https://x.y> now\n', 'x.y'))).toBe('Go <https://|x.y> now');
    expect(syntaxMarkers(stateAt('Go https://x.y now\n', 'x.y'))).toEqual([]);
  });

  it('reveals heading markers', () => {
    expect(reveal(stateAt('## Title\n\ntext\n', 'Title', 2))).toBe('## Ti|tle\ntext');
    expect(reveal(stateAt('Title\n=====\n\ntext\n', 'Title', 2))).toBe('Ti|tle\n===\ntext');
    expect(syntaxMarkers(stateAt('## Title\n\ntext\n', 'text'))).toEqual([]);
  });

  it('reveals markers of every element touched by a selection', () => {
    const state = stateAt('# A\n\nx **b** y\n\nz *c*\n', 'A', 0, 'b');
    expect(syntaxMarkers(state).map((m) => m.text)).toEqual(['# ', '**', '**']);
  });

  it('ignores node selections and code blocks', () => {
    const { doc } = parseMarkdown('```js\n**x**\n```\n\n---\n', schema);
    expect(syntaxMarkers(EditorState.create({ doc, selection: TextSelection.create(doc, 3) }))).toEqual([]);
    const hr = doc.child(0).nodeSize;
    expect(syntaxMarkers(EditorState.create({ doc, selection: NodeSelection.create(doc, hr) }))).toEqual([]);
  });
});
