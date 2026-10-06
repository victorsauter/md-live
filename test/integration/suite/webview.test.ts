/**
 * End-to-end tests driving the real editor inside the VS Code webview (Phase 14): edits made in the
 * Live editor must reach the TextDocument as minimal, single-line changes, external changes must
 * reach the webview, and Mermaid / highlighting must work under the webview CSP.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activeTabInput, closeAll, documentFor, getApi, isLiveTab, sleep, writeFixture, type TestAction, type TestProbe } from './helpers';

const SHOWCASE = fs.readFileSync(path.resolve(__dirname, '../../../test/fixtures/showcase.md'), 'utf8');

function changedLines(before: string, after: string): Array<[string | undefined, string | undefined]> {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: Array<[string | undefined, string | undefined]> = [];
  for (let i = 0; i < Math.max(endA - start, endB - start); i++) out.push([a[start + i], b[start + i]]);
  return out;
}

async function waitUntil(fn: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(100);
  }
}

async function openLive(content: string) {
  const { provider } = await getApi();
  const uri = writeFixture(content, 'webview');
  await vscode.commands.executeCommand('vscode.openWith', uri, 'marklive.editor');
  await waitUntil(() => isLiveTab(activeTabInput(), uri), 10000, 'live tab');
  const doc = documentFor(uri);
  assert.ok(await provider.whenReady(doc), 'webview ready');
  const run = (action: TestAction) => provider.runWebviewTest(doc, action);
  await waitUntil(async () => (await run({ kind: 'probe' })).editable, 10000, 'editor editable');
  return { uri, doc, run };
}

function assertNoErrors(probe: TestProbe): void {
  assert.deepStrictEqual(probe.errors, [], `webview errors: ${probe.errors.join('\n')}`);
}

suite('Webview editor (end to end)', () => {
  teardown(closeAll);

  test('opening a document never modifies it', async () => {
    const { doc, run } = await openLive(SHOWCASE);
    await sleep(800);
    assert.strictEqual(doc.isDirty, false);
    assert.strictEqual(doc.getText(), SHOWCASE);
    assertNoErrors(await run({ kind: 'probe' }));
  });

  test('typing in a paragraph changes exactly one line', async () => {
    const { doc, run } = await openLive(SHOWCASE);
    await run({ kind: 'replaceText', needle: 'Second item', text: 'Second entry' });
    await waitUntil(() => doc.getText() !== SHOWCASE, 5000, 'document updated');
    const diff = changedLines(SHOWCASE, doc.getText());
    assert.strictEqual(diff.length, 1, JSON.stringify(diff));
    assert.ok(diff[0]![1]!.includes('Second entry'));
  });

  test('bold, table cell and code edits stay on their line', async () => {
    const { doc, run } = await openLive(SHOWCASE);
    await run({ kind: 'toggleMark', needle: 'GFM', mark: 'bold' });
    await waitUntil(() => doc.getText().includes('**GFM**'), 5000, 'bold applied');
    let diff = changedLines(SHOWCASE, doc.getText());
    assert.deepStrictEqual(diff, [['| Tables | ✅ | GFM |', '| Tables | ✅ | **GFM** |']]);

    const before = doc.getText();
    await run({ kind: 'replaceText', needle: 'greet', text: 'welcome', occurrence: 0 });
    await waitUntil(() => doc.getText() !== before, 5000, 'code edit applied');
    diff = changedLines(before, doc.getText());
    assert.strictEqual(diff.length, 1, JSON.stringify(diff));
  });

  test('editor undo restores the original bytes', async () => {
    const { doc, run } = await openLive(SHOWCASE);
    await run({ kind: 'replaceText', needle: 'Second item', text: 'X' });
    await waitUntil(() => doc.getText() !== SHOWCASE, 5000, 'document updated');
    await run({ kind: 'undo' });
    await waitUntil(() => doc.getText() === SHOWCASE, 5000, 'document restored');
  });

  test('external changes reach the webview', async () => {
    const { doc, run } = await openLive(SHOWCASE);
    const edit = new vscode.WorkspaceEdit();
    const text = doc.getText();
    const offset = text.indexOf('Second item');
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + 6)), 'Updated');
    assert.ok(await vscode.workspace.applyEdit(edit));
    await waitUntil(async () => (await run({ kind: 'probe' })).textContent.includes('Updated item'), 5000, 'webview updated');
    await sleep(500);
    const diff = changedLines(SHOWCASE, doc.getText());
    assert.strictEqual(diff.length, 1, 'webview must not write back after an external update');
  });

  test('Mermaid diagrams and syntax highlighting render under the webview CSP', async () => {
    const { run } = await openLive(SHOWCASE);
    let probe: TestProbe | undefined;
    await waitUntil(
      async () => {
        probe = await run({ kind: 'probe' });
        return probe.mermaid.svg + probe.mermaid.errors >= probe.mermaid.blocks && probe.mermaid.blocks > 0;
      },
      20000,
      'mermaid rendered',
    );
    assert.strictEqual(probe!.mermaid.errors, 0, 'mermaid rendered without errors');
    assert.ok(probe!.highlightedTokens > 0, 'code is highlighted');
    assertNoErrors(probe!);
  });

  test('Markdown syntax is revealed around the element under the cursor', async () => {
    const { doc, run } = await openLive(SHOWCASE);
    const revealed = async (action: TestAction, expected: string[]) => {
      let syntax: string[] = [];
      await run(action);
      const matches = async () => JSON.stringify((syntax = (await run({ kind: 'probe' })).syntax)) === JSON.stringify(expected);
      await waitUntil(matches, 3000, 'revealed syntax').catch(() => assert.deepStrictEqual(syntax, expected));
    };
    await revealed({ kind: 'select', needle: 'underscores', offset: 3 }, ['__', '__']);
    await revealed({ kind: 'select', needle: 'Lists', offset: 2 }, ['## ']);
    await revealed({ kind: 'select', needle: 'This document', offset: 2 }, []);
    await sleep(500);
    assert.strictEqual(doc.isDirty, false, 'revealing syntax never edits the document');
    assert.strictEqual(doc.getText(), SHOWCASE);
  });
});
