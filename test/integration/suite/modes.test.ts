import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { activeTabInput, closeAll, documentFor, getApi, isLiveTab, VIEW_TYPE, waitFor, writeFixture } from './helpers';

function tabsFor(uri: vscode.Uri) {
  const out: { live: number; text: number } = { live: 0, text: 0 };
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE && input.uri.toString() === uri.toString()) out.live++;
      if (input instanceof vscode.TabInputText && input.uri.toString() === uri.toString()) out.text++;
    }
  }
  return out;
}

suite('Mode commands', () => {
  teardown(closeAll);

  test('toggle switches Live -> Source -> Live in the same tab slot', async () => {
    const uri = writeFixture('# Modes\n\ntext\n');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(() => isLiveTab(activeTabInput(), uri));
    await vscode.commands.executeCommand('marklive.toggle');
    await waitFor(() => {
      const input = activeTabInput();
      return input instanceof vscode.TabInputText && input.uri.toString() === uri.toString();
    }, 10000, 'source tab');
    await waitFor(() => tabsFor(uri).live === 0, 5000, 'live tab closed');
    await vscode.commands.executeCommand('marklive.toggle');
    await waitFor(() => isLiveTab(activeTabInput(), uri), 10000, 'live tab again');
    await waitFor(() => tabsFor(uri).text === 0, 5000, 'text tab closed');
  });

  test('switching modes keeps unsaved changes without prompting', async () => {
    const { provider } = await getApi();
    const uri = writeFixture('# Dirty\n\nbefore\n');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(() => isLiveTab(activeTabInput(), uri));
    const doc = documentFor(uri);
    assert.ok(await provider.whenReady(doc));
    await provider.simulateWebviewEdit(doc, '# Dirty\n\nafter\n');
    assert.ok(doc.isDirty);
    await vscode.commands.executeCommand('marklive.openSource');
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(), 10000, 'text editor');
    assert.strictEqual(vscode.window.activeTextEditor!.document.getText(), '# Dirty\n\nafter\n');
    assert.ok(vscode.window.activeTextEditor!.document.isDirty);
  });

  test('split opens the native editor and the Live editor side by side', async () => {
    const uri = writeFixture('# Split\n');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(() => isLiveTab(activeTabInput(), uri));
    await vscode.commands.executeCommand('marklive.openSplit');
    await waitFor(() => tabsFor(uri).text === 1 && tabsFor(uri).live === 1, 10000, 'split tabs');
    assert.ok(vscode.window.tabGroups.all.length >= 2);
  });

  test('disable/enable default editor (workspace scope only in tests)', async () => {
    await vscode.commands.executeCommand('marklive.disableDefault', 'workspace');
    const config = () => vscode.workspace.getConfiguration('workbench').inspect<Record<string, string>>('editorAssociations');
    assert.strictEqual(config()?.workspaceValue?.['*.md'], 'default');
    const uri = writeFixture('# Plain\n');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(() => {
      const input = activeTabInput();
      return input instanceof vscode.TabInputText && input.uri.toString() === uri.toString();
    }, 10000, 'text editor by default');
    await vscode.commands.executeCommand('marklive.enableDefault', 'workspace');
    assert.strictEqual(config()?.workspaceValue?.['*.md'], undefined);
  });
});
