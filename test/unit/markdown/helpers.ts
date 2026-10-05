import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { getMarkdownSchema } from '../../../shared/markdown/schema';
import { parseMarkdown } from '../../../shared/markdown/parse';
import { serializeMarkdown } from '../../../shared/markdown/serialize';
import { canonicalDoc } from '../../../shared/markdown/canonical';

export const schema = getMarkdownSchema();

export function roundTrip(text: string): string {
  const { doc, base } = parseMarkdown(text, schema);
  return serializeMarkdown(doc, base);
}

/** Parse `text`, apply `edit` to an editor state, serialize the result. */
export function edit(text: string, fn: (tr: Transaction, doc: PMNode) => void): string {
  const { doc, base } = parseMarkdown(text, schema);
  const state = EditorState.create({ doc, schema });
  const tr = state.tr;
  fn(tr, tr.doc);
  return serializeMarkdown(tr.doc, base);
}

/** Position right after the first occurrence of `needle` in the document text. */
export function find(doc: PMNode, needle: string, occurrence = 0): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  let count = 0;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.isText) {
      let idx = node.text!.indexOf(needle);
      while (idx >= 0) {
        if (count++ === occurrence) {
          found = { from: pos + idx, to: pos + idx + needle.length };
          return false;
        }
        idx = node.text!.indexOf(needle, idx + 1);
      }
    }
    return true;
  });
  if (!found) throw new Error(`"${needle}" not found`);
  return found;
}

export function replaceText(needle: string, replacement: string, occurrence = 0) {
  return (tr: Transaction, doc: PMNode) => {
    const { from, to } = find(doc, needle, occurrence);
    const marks = doc.resolve(from + 1).marks();
    if (replacement) tr.replaceWith(from, to, schema.text(replacement, marks));
    else tr.delete(from, to);
  };
}

export function lineDiff(a: string, b: string): { removed: string[]; added: string[] } {
  const al = a.split('\n');
  const bl = b.split('\n');
  let s = 0;
  while (s < al.length && s < bl.length && al[s] === bl[s]) s++;
  let ea = al.length;
  let eb = bl.length;
  while (ea > s && eb > s && al[ea - 1] === bl[eb - 1]) {
    ea--;
    eb--;
  }
  return { removed: al.slice(s, ea), added: bl.slice(s, eb) };
}

export function canonicalOf(text: string): unknown {
  return canonicalDoc(parseMarkdown(text, schema).doc);
}

export { TextSelection };
