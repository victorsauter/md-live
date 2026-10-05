/**
 * Phase 2b spike: verify how VS Code routes undo/redo, save and diff views when the Live editor
 * (CustomTextEditorProvider) is involved. The findings are documented in README "Architecture".
 */
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { activeTabInput, closeAll, documentFor, getApi, isLiveTab, readBytes, sleep, waitFor, writeFixture } from './helpers';

suite('Spike: VS Code integration', () => {
  teardown(closeAll);

  test('Live editor is the default editor for .md files', async () => {
    const { provider } = await getApi();
    const uri = writeFixture('# Title\n\nHello world\n');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(() => isLiveTab(activeTabInput(), uri), 10000, 'live tab');
    const doc = documentFor(uri);
    assert.ok(await provider.whenReady(doc), 'webview ready');
  });

  test('workbench undo after a Live edit reverts the TextDocument', async () => {
    const { provider } = await getApi();
    const uri = writeFixture('# Title\n\nHello world\n');
    await vscode.commands.executeCommand('vscode.openWith', uri, 'liveMarkdown.editor');
    await waitFor(() => isLiveTab(activeTabInput(), uri));
    const doc = documentFor(uri);
    assert.ok(await provider.whenReady(doc));
    await provider.simulateWebviewEdit(doc, '# Title\n\nHello there\n');
    assert.strictEqual(doc.getText(), '# Title\n\nHello there\n');
    assert.ok(doc.isDirty);
    await vscode.commands.executeCommand('undo');
    await waitFor(() => doc.getText() === '# Title\n\nHello world\n', 5000, 'undo applied');
    await vscode.commands.executeCommand('redo');
    await waitFor(() => doc.getText() === '# Title\n\nHello there\n', 5000, 'redo applied');
    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitFor(() => !doc.isDirty, 5000, 'saved');
    assert.strictEqual(readBytes(uri), '# Title\n\nHello there\n');
  });

  test('CRLF documents keep CRLF and untouched lines', async () => {
    const { provider } = await getApi();
    const uri = writeFixture('# Title\r\n\r\nline one\r\nline two\r\n');
    await vscode.commands.executeCommand('vscode.openWith', uri, 'liveMarkdown.editor');
    await waitFor(() => isLiveTab(activeTabInput(), uri));
    const doc = documentFor(uri);
    assert.ok(await provider.whenReady(doc));
    await provider.simulateWebviewEdit(doc, '# Title\n\nline 1\nline two\n');
    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitFor(() => !doc.isDirty, 5000, 'saved');
    assert.strictEqual(readBytes(uri), '# Title\r\n\r\nline 1\r\nline two\r\n');
  });

  test('diff of two markdown files (records which editor VS Code uses)', async () => {
    const { provider } = await getApi();
    const left = writeFixture('# A\n\none\n', 'left');
    const right = writeFixture('# A\n\ntwo\n', 'right');
    const before = provider.openEditorCount;
    await vscode.commands.executeCommand('vscode.diff', left, right, 'spike diff');
    await sleep(1500);
    const input = activeTabInput();
    const kind =
      input instanceof vscode.TabInputTextDiff
        ? 'TabInputTextDiff'
        : input instanceof vscode.TabInputCustom
          ? `TabInputCustom(${input.viewType})`
          : input === undefined
            ? 'undefined'
            : (input as object).constructor?.name ?? typeof input;
    const resolvedLive = provider.openEditorCount - before;
    console.log(`[spike] diff tab input: ${kind}; Live editors resolved for diff: ${resolvedLive}`);
    assert.ok(true);
  });
});
