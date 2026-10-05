/**
 * Markdown clipboard conversions: pasted Markdown to a ProseMirror slice of fresh nodes, and copied
 * slices to Markdown for the text/plain flavour.
 */
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { parseMarkdown } from './parse';
import { serializeMarkdown } from './serialize';

export function stripSourceIds(node: PMNode, schema: Schema): PMNode {
  const json = node.toJSON() as Record<string, unknown>;
  const walk = (value: Record<string, unknown>) => {
    // toJSON() shares the live attrs objects: copy them, never mutate the document's nodes.
    const attrs = value.attrs as Record<string, unknown> | undefined;
    if (attrs && 'sid' in attrs) value.attrs = { ...attrs, sid: null };
    for (const child of (value.content as Array<Record<string, unknown>> | undefined) ?? []) walk(child);
  };
  walk(json);
  return schema.nodeFromJSON(json);
}

/** Parse pasted Markdown into a slice of fresh nodes (no source ids). */
export function markdownToSlice(text: string, schema: Schema): Slice {
  const { doc } = parseMarkdown(text.replace(/\r\n?/g, '\n'), schema);
  const fresh = stripSourceIds(doc, schema);
  return Slice.maxOpen(fresh.content);
}

function wrapForSerialization(content: Fragment, schema: Schema): PMNode | null {
  const first = content.firstChild;
  if (!first) return null;
  const nodes = schema.nodes;
  let wrapped: Fragment = content;
  if (first.isInline) wrapped = Fragment.from(nodes.paragraph!.create(null, content));
  else if (first.type === nodes.listItem) wrapped = Fragment.from(nodes.bulletList!.create(null, content));
  else if (first.type === nodes.tableRow) wrapped = Fragment.from(nodes.table!.create(null, content));
  else if (first.type === nodes.tableCell || first.type === nodes.tableHeader) {
    wrapped = Fragment.from(nodes.paragraph!.create(null, content.firstChild!.content));
  }
  try {
    const doc = schema.topNodeType.create(null, wrapped);
    doc.check();
    return stripSourceIds(doc, schema);
  } catch {
    return null;
  }
}

/** Markdown for the text/plain clipboard flavour. */
export function sliceToMarkdown(slice: Slice, schema: Schema): string {
  // A selection inside a single textblock (e.g. part of a list item) copies as inline Markdown.
  let content = slice.content;
  for (let depth = 0; depth < Math.min(slice.openStart, slice.openEnd); depth++) {
    const only = content.childCount === 1 ? content.firstChild : null;
    if (!only || only.isInline || only.isLeaf) break;
    if (only.isTextblock) {
      if (only.type.spec.code) return only.textContent;
      content = only.content;
      break;
    }
    content = only.content;
  }
  if (content.firstChild?.isInline !== true) content = slice.content;
  const doc = wrapForSerialization(content, schema);
  if (doc) {
    try {
      const empty = parseMarkdown('', schema).base;
      return serializeMarkdown(doc, empty).replace(/\n$/, '');
    } catch {
      // fall back to plain text
    }
  }
  return slice.content.textBetween(0, slice.content.size, '\n\n');
}
