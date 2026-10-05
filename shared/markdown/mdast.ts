/** Markdown → mdast with the syntax extensions the editor understands. */
import type { Node, Parent, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';

const FRONTMATTER = ['yaml', 'toml'] as const;

export function parseMdast(text: string): Root {
  const root = fromMarkdown(text, {
    extensions: [gfm(), frontmatter([...FRONTMATTER]), math({ singleDollarTextMath: false })],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown([...FRONTMATTER]), mathFromMarkdown()],
  });
  // micromark skips a leading byte order mark and reports offsets relative to the text without it.
  if (text.charCodeAt(0) === 0xfeff) shiftOffsets(root, 1);
  return root;
}

function shiftOffsets(root: Root, delta: number): void {
  const seen = new Set<object>();
  const visit = (node: Node) => {
    for (const point of [node.position?.start, node.position?.end]) {
      if (!point || seen.has(point)) continue;
      seen.add(point);
      if (point.offset !== undefined) point.offset += delta;
      if (point.line === 1) point.column += delta;
    }
    for (const child of (node as Parent).children ?? []) visit(child);
  };
  visit(root);
}
