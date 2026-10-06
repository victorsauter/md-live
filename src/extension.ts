import * as vscode from 'vscode';
import { ModeCommands } from './commands/commands';
import { MarkdownEditorProvider } from './editor/MarkdownEditorProvider';

export interface MarkliveApi {
  provider: MarkdownEditorProvider;
  /** Used by the integration tests to verify they run in an isolated profile. */
  globalStorageUri: vscode.Uri;
}

export function activate(context: vscode.ExtensionContext): MarkliveApi {
  const provider = MarkdownEditorProvider.register(context);
  new ModeCommands(provider).register(context);
  return { provider, globalStorageUri: context.globalStorageUri };
}

export function deactivate(): void {
  // Everything is registered on the context subscriptions.
}
