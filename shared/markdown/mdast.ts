/** Markdown → mdast with the syntax extensions the editor understands. */
import type { Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';

const FRONTMATTER = ['yaml', 'toml'] as const;

export function parseMdast(text: string): Root {
  return fromMarkdown(text, {
    extensions: [gfm(), frontmatter([...FRONTMATTER]), math({ singleDollarTextMath: false })],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown([...FRONTMATTER]), mathFromMarkdown()],
  });
}
