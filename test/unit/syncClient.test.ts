import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { getMarkdownSchema } from '../../shared/markdown';
import { SyncClient, type SyncStatus } from '../../shared/sync/SyncClient';
import type { EditMessage } from '../../shared/protocol';

const schema = getMarkdownSchema();

function setup(text: string) {
  let state = EditorState.create({ schema });
  const posted: EditMessage[] = [];
  const statuses: SyncStatus[] = [];
  const client = new SyncClient({
    getState: () => state,
    dispatch: (tr: Transaction) => {
      state = state.apply(tr);
      client.onTransaction(tr);
    },
    setDoc: (doc: PMNode) => {
      state = EditorState.create({ schema, doc, plugins: state.plugins });
    },
    post: (m) => posted.push(m),
    onStatus: (s) => statuses.push(s),
  });
  client.delay = 1_000_000;
  client.handleMessage({
    type: 'init',
    text,
    version: 1,
    config: { syntaxReveal: true, syncDelay: 0, mermaidEnabled: true, maxWidth: '900px' },
    documentUri: 'file:///a.md',
    baseUri: 'https://x/',
    fileName: 'a.md',
  });
  const edit = (fn: (tr: Transaction, doc: PMNode) => void) => {
    const tr = state.tr;
    fn(tr, state.doc);
    state = state.apply(tr);
    client.onTransaction(tr);
  };
  const find = (word: string) => {
    let found = -1;
    state.doc.descendants((node, pos) => {
      if (found < 0 && node.isText && node.text!.includes(word)) found = pos + node.text!.indexOf(word);
    });
    if (found < 0) throw new Error(`not found: ${word}`);
    return { from: found, to: found + word.length };
  };
  const replace = (word: string, by: string) =>
    edit((tr) => {
      const { from, to } = find(word);
      tr.insertText(by, from, to);
    });
  return { client, posted, statuses, edit, replace, find, get state() { return state; } };
}

const DOC = '# Title\n\nSome  *text*  here.\n\n- a\n-   b\n\n<div align="center">\n  html\n</div>\n';

describe('SyncClient', () => {
  it('sends the minimally changed text with the base version', () => {
    const t = setup(DOC);
    t.replace('text', 'words');
    expect(t.posted).toHaveLength(0);
    expect(t.client.send()).toBe(true);
    expect(t.posted).toEqual([
      { type: 'edit', text: DOC.replace('text', 'words'), baseVersion: 1, editId: 1 },
    ]);
  });

  it('does not send when the text is unchanged', () => {
    const t = setup(DOC);
    t.replace('text', 'text');
    t.client.send();
    expect(t.posted).toHaveLength(0);
    expect(t.client.currentStatus.kind).toBe('synced');
  });

  it('uses the acknowledged version for the next edit', () => {
    const t = setup(DOC);
    t.replace('Title', 'Heading');
    t.client.send();
    t.client.handleMessage({ type: 'ack', editId: 1, version: 2 });
    t.replace('here', 'there');
    t.client.send();
    expect(t.posted[1]).toMatchObject({ baseVersion: 2, text: DOC.replace('Title', 'Heading').replace('here', 'there') });
  });

  it('applies external updates and keeps unchanged blocks', () => {
    const t = setup(DOC);
    const list = t.state.doc.child(2);
    const external = DOC.replace('Some', 'Many');
    t.client.handleMessage({ type: 'update', text: external, version: 2 });
    expect(t.state.doc.child(2)).toBe(list);
    expect(t.state.doc.child(1).textContent).toContain('Many');
    // A later local edit is written against the new text.
    t.replace('Title', 'T');
    t.client.send();
    expect(t.posted).toEqual([{ type: 'edit', text: external.replace('Title', 'T'), baseVersion: 2, editId: 1 }]);
  });

  it('keeps the selection when an external change touches another block', () => {
    const t = setup(DOC);
    const { from } = t.find('here');
    t.edit((tr) => tr.setSelection(TextSelection.create(tr.doc, from)));
    t.client.handleMessage({ type: 'update', text: DOC.replace('# Title', '# Longer title'), version: 2 });
    expect(t.state.selection.from).toBe(t.find('here').from);
  });

  it('defers updates while an edit is in flight and drops the stale ones', () => {
    const t = setup(DOC);
    t.replace('text', 'words');
    t.client.send();
    const mine = t.posted[0]!.text;
    t.client.handleMessage({ type: 'update', text: DOC, version: 2 });
    expect(t.state.doc.textContent).toContain('words');
    t.client.handleMessage({ type: 'ack', editId: 1, version: 3 });
    expect(t.state.doc.textContent).toContain('words');
    // The host rebased our edit on an external change and sends the merged text.
    const merged = mine.replace('Title', 'Merged');
    t.client.handleMessage({ type: 'update', text: merged, version: 3 });
    expect(t.state.doc.child(0).textContent).toBe('Merged');
    expect(t.state.doc.textContent).toContain('words');
  });

  it('sends pending local changes before applying an update', () => {
    const t = setup(DOC);
    t.replace('text', 'words');
    t.client.handleMessage({ type: 'update', text: DOC.replace('Title', 'Other'), version: 2 });
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0]!.baseVersion).toBe(1);
    expect(t.state.doc.child(0).textContent).toBe('Title');
  });

  it('applies the host text after a rejected edit', () => {
    const t = setup(DOC);
    t.replace('text', 'words');
    t.client.send();
    t.client.handleMessage({ type: 'reject', editId: 1, reason: 'conflict' });
    t.client.handleMessage({ type: 'update', text: DOC, version: 2 });
    expect(t.state.doc.textContent).toContain('text');
  });

  it('writes edited raw sources verbatim and re-parses them', () => {
    const t = setup(DOC);
    let pos = -1;
    t.state.doc.forEach((node, offset) => {
      if (node.type.name === 'rawBlock') pos = offset;
    });
    expect(t.client.editRawSource(pos, '**not html**')).toBe(true);
    expect(t.posted.at(-1)!.text).toBe('# Title\n\nSome  *text*  here.\n\n- a\n-   b\n\n**not html**\n');
    const last = t.state.doc.lastChild!;
    expect(last.type.name).toBe('paragraph');
    expect(last.firstChild!.marks.map((m) => m.type.name)).toEqual(['bold']);
    // Further edits use the re-parsed source.
    t.replace('html', 'markdown');
    t.client.send();
    expect(t.posted.at(-1)!.text).toBe('# Title\n\nSome  *text*  here.\n\n- a\n-   b\n\n**not markdown**\n');
  });

  it('reports a pending status until the edit is acknowledged', () => {
    const t = setup(DOC);
    t.replace('text', 'words');
    expect(t.client.currentStatus.kind).toBe('pending');
    t.client.send();
    expect(t.client.hasPendingChanges).toBe(true);
    t.client.handleMessage({ type: 'ack', editId: 1, version: 2 });
    expect(t.client.currentStatus.kind).toBe('synced');
    expect(t.client.hasPendingChanges).toBe(false);
  });
});
