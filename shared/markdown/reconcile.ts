/**
 * Keeping the source map in sync with the editor document.
 *
 * - `rebind` points every origin at the node instance that currently represents it in the editor,
 *   so that unchanged blocks are recognised by identity (fast path of the serializer).
 * - `reconcile` applies an external change of the Markdown text (another editor, git checkout,
 *   undo in the text editor...) to the editor document while keeping untouched blocks, and
 *   therefore the selection and the undo history, as stable as possible.
 */
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { parseMarkdown } from './parse';
import type { SourceBase } from './types';

export function rebind(doc: PMNode, base: SourceBase): void {
  const seen = new Set<string>();
  doc.descendants((node) => {
    const sid = node.attrs.sid as string | null | undefined;
    if (sid && !seen.has(sid)) {
      seen.add(sid);
      const origin = base.origins.get(sid);
      if (origin && origin.type === node.type.name) origin.node = node;
    }
    return !node.isTextblock;
  });
}

function attrsEqualIgnoringSid(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const key of Object.keys(a)) if (key !== 'sid' && a[key] !== b[key]) return false;
  for (const key of Object.keys(b)) if (key !== 'sid' && !(key in a)) return false;
  return true;
}

/** Structural equality ignoring `sid` attributes. */
export function eqIgnoringSid(a: PMNode, b: PMNode): boolean {
  if (a === b) return true;
  if (a.type !== b.type || !attrsEqualIgnoringSid(a.attrs, b.attrs)) return false;
  if (a.isText) return a.text === b.text && a.sameMarkup(b);
  if (a.marks.length !== b.marks.length || !a.marks.every((m, i) => m.eq(b.marks[i]!))) return false;
  if (a.childCount !== b.childCount) return false;
  for (let i = 0; i < a.childCount; i++) if (!eqIgnoringSid(a.child(i), b.child(i))) return false;
  return true;
}

/** Transfer origins of `fresh` (just parsed) to the matching editor node `kept`. */
function adopt(kept: PMNode, fresh: PMNode, base: SourceBase, missing: Array<{ node: PMNode; sid: string }>): void {
  const keptSid = kept.attrs.sid as string | null | undefined;
  const freshSid = fresh.attrs.sid as string | null | undefined;
  if (freshSid) {
    const origin = base.origins.get(freshSid);
    if (origin) {
      if (keptSid && keptSid !== freshSid && !base.origins.has(keptSid)) {
        base.origins.delete(freshSid);
        origin.sid = keptSid;
        base.origins.set(keptSid, origin);
      } else if (!keptSid) {
        missing.push({ node: kept, sid: freshSid });
      }
      origin.node = kept;
    }
  }
  if (!kept.isTextblock) for (let i = 0; i < kept.childCount; i++) adopt(kept.child(i), fresh.child(i), base, missing);
}

export interface ReconcileResult {
  base: SourceBase;
  /** Transaction to dispatch (not added to the undo history), or null when nothing changed. */
  tr: Transaction | null;
}

/** Build the transaction that turns the editor document into the parse of `text`. */
export function reconcile(state: EditorState, text: string, schema: Schema = state.schema): ReconcileResult {
  const { doc: fresh, base } = parseMarkdown(text, schema);
  const doc = state.doc;
  const oldCount = doc.childCount;
  const newCount = fresh.childCount;
  let start = 0;
  while (start < oldCount && start < newCount && eqIgnoringSid(doc.child(start), fresh.child(start))) start++;
  let endOld = oldCount;
  let endNew = newCount;
  while (endOld > start && endNew > start && eqIgnoringSid(doc.child(endOld - 1), fresh.child(endNew - 1))) {
    endOld--;
    endNew--;
  }
  const missing: Array<{ node: PMNode; sid: string }> = [];
  for (let i = 0; i < start; i++) adopt(doc.child(i), fresh.child(i), base, missing);
  for (let i = 0; i < oldCount - endOld; i++) adopt(doc.child(endOld + i), fresh.child(endNew + i), base, missing);

  let tr: Transaction | null = null;
  if (start < endOld || start < endNew) {
    let from = 0;
    for (let i = 0; i < start; i++) from += doc.child(i).nodeSize;
    let to = from;
    for (let i = start; i < endOld; i++) to += doc.child(i).nodeSize;
    const nodes: PMNode[] = [];
    for (let i = start; i < endNew; i++) nodes.push(fresh.child(i));
    tr = state.tr.replaceWith(from, to, nodes);
  }
  if (missing.length) {
    tr ??= state.tr;
    const positions = new Map<PMNode, number>();
    tr.doc.descendants((node, pos) => {
      positions.set(node, pos);
      return true;
    });
    for (const { node, sid } of missing) {
      const pos = positions.get(node);
      // Positions are taken from tr.doc and attribute steps do not move content: no mapping needed.
      if (pos !== undefined) tr.setNodeAttribute(pos, 'sid', sid);
    }
  }
  if (tr) tr.setMeta('addToHistory', false).setMeta('liveMarkdownExternal', true).setMeta('preventAutolink', true);
  return { base, tr };
}
