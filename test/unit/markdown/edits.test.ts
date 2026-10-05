import { describe, expect, it } from 'vitest';
import { edit, find, lineDiff, replaceText, schema } from './helpers';

const DOC = [
  '---',
  'title: Doc',
  '---',
  '',
  '# Heading  one',
  '',
  'First paragraph with a word and *emphasis*',
  'spanning two lines &amp; an entity.',
  '',
  '<div align="center">raw html</div>',
  '',
  '- item alpha',
  '- [ ] task beta',
  '   - nested gamma',
  '',
  '| col a | col b |',
  '|:------|------:|',
  '| one   | two   |',
  '',
  '```js',
  'const x = 1;',
  'const y = 2;',
  '```',
  '',
  'See [ref] and [[Wiki Link]] and $x$.',
  '',
  '[ref]: https://example.com',
  '',
].join('\n');

function oneLine(before: string, after: string, expectedRemoved: string, expectedAdded: string) {
  const d = lineDiff(before, after);
  expect(d).toEqual({ removed: [expectedRemoved], added: [expectedAdded] });
}

describe('targeted edits change a single line', () => {
  it('word in paragraph', () => {
    const out = edit(DOC, replaceText('word', 'term'));
    oneLine(DOC, out, 'First paragraph with a word and *emphasis*', 'First paragraph with a term and *emphasis*');
  });

  it('word inside emphasis', () => {
    const out = edit(DOC, replaceText('emphasis', 'stress'));
    oneLine(DOC, out, 'First paragraph with a word and *emphasis*', 'First paragraph with a word and *stress*');
  });

  it('second line of paragraph keeps the entity', () => {
    const out = edit(DOC, replaceText('spanning', 'covering'));
    oneLine(DOC, out, 'spanning two lines &amp; an entity.', 'covering two lines &amp; an entity.');
  });

  it('heading text keeps the double space', () => {
    const out = edit(DOC, replaceText('one', 'One', 0));
    oneLine(DOC, out, '# Heading  one', '# Heading  One');
  });

  it('list item', () => {
    const out = edit(DOC, replaceText('alpha', 'ALPHA'));
    oneLine(DOC, out, '- item alpha', '- item ALPHA');
  });

  it('nested list item keeps its odd indentation', () => {
    const out = edit(DOC, replaceText('gamma', 'delta'));
    oneLine(DOC, out, '   - nested gamma', '   - nested delta');
  });

  it('table cell keeps the column padding of other cells', () => {
    const out = edit(DOC, replaceText('two', 'deux', 1));
    const d = lineDiff(DOC, out);
    expect(d.removed).toEqual(['| one   | two   |']);
    expect(d.added).toHaveLength(1);
    expect(d.added[0]).toMatch(/^\| one {3}\| deux\s*\|$/);
  });

  it('code block line', () => {
    const out = edit(DOC, replaceText('y = 2', 'y = 3'));
    oneLine(DOC, out, 'const y = 2;', 'const y = 3;');
  });

  it('paragraph with wikilink, reference and math', () => {
    const out = edit(DOC, replaceText('See', 'Look at'));
    oneLine(DOC, out, 'See [ref] and [[Wiki Link]] and $x$.', 'Look at [ref] and [[Wiki Link]] and $x$.');
  });

  it('task toggle', () => {
    const out = edit(DOC, (tr, doc) => {
      const { from } = find(doc, 'task beta');
      const $pos = doc.resolve(from);
      for (let d = $pos.depth; d > 0; d--) {
        const node = $pos.node(d);
        if (node.type.name === 'listItem') {
          tr.setNodeAttribute($pos.before(d), 'checked', true);
          break;
        }
      }
    });
    oneLine(DOC, out, '- [ ] task beta', '- [x] task beta');
  });

  it('heading level', () => {
    const out = edit(DOC, (tr, doc) => {
      const { from } = find(doc, 'Heading');
      const $pos = doc.resolve(from);
      tr.setNodeAttribute($pos.before($pos.depth), 'level', 3);
    });
    oneLine(DOC, out, '# Heading  one', '### Heading  one');
  });

  it('bold a word', () => {
    const out = edit(DOC, (tr, doc) => {
      const { from, to } = find(doc, 'word');
      tr.addMark(from, to, schema.marks.bold!.create());
    });
    const d = lineDiff(DOC, out);
    expect(d.removed).toEqual(['First paragraph with a word and *emphasis*']);
    expect(d.added).toEqual(['First paragraph with a **word** and *emphasis*']);
  });

  it('typing special characters escapes them', () => {
    const out = edit(DOC, replaceText('word', 'a *star* [x]'));
    const d = lineDiff(DOC, out);
    expect(d.added).toEqual(['First paragraph with a a \\*star\\* \\[x\\] and *emphasis*']);
  });
});

describe('structural edits', () => {
  it('new paragraph after the first one', () => {
    const out = edit(DOC, (tr, doc) => {
      const { to } = find(doc, 'entity.');
      const $pos = doc.resolve(to);
      const after = $pos.after($pos.depth);
      tr.insert(after, schema.nodes.paragraph!.create(null, schema.text('Inserted.')));
    });
    expect(out).toBe(DOC.replace('entity.\n', 'entity.\n\nInserted.\n'));
  });

  it('split paragraph', () => {
    const out = edit(DOC, (tr, doc) => {
      tr.split(find(doc, 'and').from);
    });
    expect(out).toMatch(/with a word ?\n\nand \*emphasis\*\nspanning/);
  });

  it('insert list item', () => {
    const out = edit(DOC, (tr, doc) => {
      const { to } = find(doc, 'item alpha');
      tr.split(to, 2);
      tr.insertText('new item', tr.mapping.map(to) + 0);
    });
    const d = lineDiff(DOC, out);
    expect(d.removed).toEqual([]);
    expect(d.added).toEqual(['- new item']);
  });

  it('delete a block keeps its neighbours intact', () => {
    const out = edit(DOC, (tr, doc) => {
      let start = -1;
      let end = -1;
      doc.forEach((node, offset) => {
        if (node.type.name === 'rawBlock' && node.attrs.kind === 'html' && start < 0) {
          start = offset;
          end = offset + node.nodeSize;
        }
      });
      tr.delete(start, end);
    });
    expect(out).toBe(DOC.replace('<div align="center">raw html</div>\n\n', ''));
  });

  it('empty document after deleting everything', () => {
    const out = edit('# a\n\nb\n', (tr, doc) => {
      tr.replaceWith(0, doc.content.size, schema.nodes.paragraph!.create());
    });
    expect(out).toBe('');
  });
});
