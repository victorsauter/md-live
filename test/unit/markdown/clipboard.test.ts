import { describe, expect, it } from 'vitest';
import { getMarkdownSchema, parseMarkdown, serializeMarkdown } from '../../../shared/markdown';
import { markdownToSlice, sliceToMarkdown } from '../../../shared/markdown/clipboard';

const schema = getMarkdownSchema();

const source = [
  '# Title',
  '',
  '- First item',
  '- Second item with **bold**',
  '  - Nested item',
  '* Other list',
  '',
  '```ts',
  'const x = 1;',
  '```',
  '',
].join('\n');

function sliceBetween(from: string, to: string) {
  const { doc, base } = parseMarkdown(source, schema);
  let start = -1;
  let end = -1;
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const a = node.text!.indexOf(from);
    if (start < 0 && a >= 0) start = pos + a;
    const b = node.text!.indexOf(to);
    if (b >= 0) end = pos + b + to.length;
    return true;
  });
  return { doc, base, slice: doc.slice(start, end) };
}

describe('markdown clipboard', () => {
  it('copies a selection inside one textblock as inline Markdown', () => {
    const { slice } = sliceBetween('Second', 'bold');
    expect(sliceToMarkdown(slice, schema)).toBe('Second item with **bold**');
  });

  it('copies list items as a Markdown list', () => {
    const { slice } = sliceBetween('item', 'Nested item');
    expect(sliceToMarkdown(slice, schema)).toBe('- item\n- Second item with **bold**\n  - Nested item');
  });

  it('copies code as plain text', () => {
    const { slice } = sliceBetween('const', '= 1');
    expect(sliceToMarkdown(slice, schema)).toBe('const x = 1');
  });

  it('does not mutate the document it copies from', () => {
    const { doc, base, slice } = sliceBetween('item', 'Nested item');
    const before = JSON.stringify(doc.toJSON());
    sliceToMarkdown(slice, schema);
    expect(JSON.stringify(doc.toJSON())).toBe(before);
    expect(serializeMarkdown(doc, base)).toBe(source);
  });

  it('parses pasted Markdown into fresh nodes', () => {
    const slice = markdownToSlice('# Pasted\r\n\r\n- a **b**\r\n- c\r\n', schema);
    const types: string[] = [];
    let sids = 0;
    slice.content.descendants((node) => {
      types.push(node.type.name);
      if (node.attrs.sid) sids++;
      return true;
    });
    expect(types).toContain('heading');
    expect(types).toContain('bulletList');
    expect(sids).toBe(0);
  });
});
