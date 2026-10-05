import { describe, expect, it } from 'vitest';
import { getMarkdownSchema } from '../../../shared/markdown/schema';
import { parseMarkdown } from '../../../shared/markdown/parse';
import { serializeMarkdown } from '../../../shared/markdown/serialize';
import { edit, replaceText } from './helpers';

const schema = getMarkdownSchema();

const samples: Record<string, string> = {
  empty: '',
  onlyNewline: '\n',
  para: 'Hello world\n',
  noFinalNewline: 'Hello world',
  headings: '# Title\n\nSome *text* and **bold**.\n\n## Sub ##\n\nSetext\n======\n\nSetext 2\n---\n',
  lists: '- a\n- b\n  - nested\n  - nested 2\n- c\n\n1. one\n2. two\n3. three\n\n* star\n+ plus\n',
  tasks: '- [ ] todo\n- [x] done\n- [X] Done upper\n',
  code: '```ts\nconst a = 1;\n```\n\n    indented code\n    line 2\n\n~~~\ntilde\n~~~\n',
  quote: '> quote\n> continued\n>\n> > nested\n',
  table: '| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 |\n',
  tableEscaped: '| a \\| b | c |\n| --- | --- |\n| `x\\|y` | z |\n',
  frontmatter: '---\ntitle: Test\ntags: [a, b]\n---\n\n# Hello\n',
  html: '<div align="center">\n  <img src="x.png">\n</div>\n\nText with <span>inline</span> html.\n',
  footnotes: 'Text with a note[^1].\n\n[^1]: The note.\n',
  refs: 'See [the docs][docs] and [docs].\n\n[docs]: https://example.com "Title"\n',
  wikilinks: 'Link to [[Some Page]] and [[Other|alias]].\n',
  math: 'Inline $a^2$ math.\n\n$$\nE = mc^2\n$$\n',
  unicode: 'Émoji 🎉 and 中文 text — “quotes”.\n',
  tabs: '-\ttab item\n\n\tcode with tab\n',
  escapes: 'Escaped \\*not em\\* and \\_x\\_ and 1\\. not list &amp; &copy;\n',
  hardBreaks: 'line one  \nline two\\\nline three\n',
  links: '[text](https://a.b "t") <https://auto.link> https://bare.link ![img](i.png)\n',
  hr: 'a\n\n***\n\nb\n\n- - -\n',
  crlfLike: 'a\n\n\n\nb\n',
  trailingSpaces: 'a\n\n   \n',
  emphasisMix: '_under_ *star* __bold__ ~~strike~~ ***both***\n',
  looseList: '- a\n\n- b\n\n  para in b\n',
  orderedParen: '1) a\n2) b\n',
  orderedStart: '5. five\n6. six\n',
  nestedQuoteList: '> - a\n>   - b\n> 1. c\n',
  emptyItem: '-\n- b\n',
  htmlComment: '<!-- comment -->\n\nText\n',
  bom: '\uFEFF# Title\n\ntext\n',
  bomParagraphBeforeFence: '\uFEFF# T\n\n**W:**\n```cs\nx\n```',
};

describe('byte order mark', () => {
  it('is kept when the first block changes', () => {
    expect(edit('\uFEFF# Title\n\ntext\n', replaceText('Title', 'Heading'))).toBe('\uFEFF# Heading\n\ntext\n');
  });

  it('is kept when the first block is deleted', () => {
    const out = edit('\uFEFF# Title\n\ntext\n', (tr, doc) => {
      tr.delete(0, doc.firstChild!.nodeSize);
    });
    expect(out).toBe('\uFEFFtext\n');
  });
});

describe('golden round trip', () => {
  for (const [name, text] of Object.entries(samples)) {
    it(name, () => {
      const { doc, base } = parseMarkdown(text, schema);
      expect(serializeMarkdown(doc, base)).toBe(text);
    });
  }
});
