import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

export const VIEW_TYPE = 'liveMarkdown.editor';

export interface ProviderHooks {
  whenReady(document: vscode.TextDocument, timeoutMs?: number): Promise<boolean>;
  simulateWebviewEdit(document: vscode.TextDocument, text: string, baseVersion?: number): Promise<void>;
  readonly openEditorCount: number;
}

export async function getApi(): Promise<{ provider: ProviderHooks; globalStorageUri: vscode.Uri }> {
  const ext = vscode.extensions.getExtension('savt.live-markdown-editor');
  if (!ext) throw new Error('extension not found');
  return (await ext.activate()) as { provider: ProviderHooks; globalStorageUri: vscode.Uri };
}

export function workspaceDir(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('no workspace folder');
  return folder.uri.fsPath;
}

let counter = 0;

/** Write a fresh Markdown file (exact bytes) in the test workspace. */
export function writeFixture(content: string, name = 'doc'): vscode.Uri {
  const file = path.join(workspaceDir(), `${name}-${Date.now()}-${counter++}.md`);
  fs.writeFileSync(file, content, 'utf8');
  return vscode.Uri.file(file);
}

export function readBytes(uri: vscode.Uri): string {
  return fs.readFileSync(uri.fsPath, 'utf8');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 10000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(50);
  }
}

export function activeTabInput(): unknown {
  return vscode.window.tabGroups.activeTabGroup.activeTab?.input;
}

export function isLiveTab(input: unknown, uri?: vscode.Uri): boolean {
  return (
    input instanceof vscode.TabInputCustom &&
    input.viewType === VIEW_TYPE &&
    (!uri || input.uri.toString() === uri.toString())
  );
}

export async function closeAll(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

export function documentFor(uri: vscode.Uri): vscode.TextDocument {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (!doc) throw new Error(`document not open: ${uri.toString()}`);
  return doc;
}

/**
 * Root hook: refuse to run when the test instance is not using the isolated profile in
 * `.vscode-test/` (e.g. a portable VS Code would share the real user's profile and settings).
 */
suiteSetup(async function () {
  const { globalStorageUri } = await getApi();
  const storage = globalStorageUri.fsPath.replace(/\\/g, '/').toLowerCase();
  if (!storage.includes('/.vscode-test/user-data/')) {
    throw new Error(`Refusing to run integration tests outside the isolated profile (globalStorage: ${globalStorageUri.fsPath})`);
  }
});