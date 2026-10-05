import * as vscode from 'vscode';
import { MarkdownEditorProvider, VIEW_TYPE } from '../editor/MarkdownEditorProvider';

const MARKDOWN_GLOBS = ['*.md', '*.markdown'];

function isMarkdownUri(uri: vscode.Uri | undefined): uri is vscode.Uri {
  return !!uri && /\.(md|markdown)$/i.test(uri.path);
}

function findTab(uri: vscode.Uri, kind: 'live' | 'text', group?: vscode.TabGroup): vscode.Tab | undefined {
  const groups = group ? [group] : vscode.window.tabGroups.all;
  for (const g of groups) {
    for (const tab of g.tabs) {
      const input = tab.input;
      if (kind === 'live' && input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE) {
        if (input.uri.toString() === uri.toString()) return tab;
      }
      if (kind === 'text' && input instanceof vscode.TabInputText && input.uri.toString() === uri.toString()) {
        return tab;
      }
    }
  }
  return undefined;
}

export class ModeCommands {
  constructor(private readonly provider: MarkdownEditorProvider) {}

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand('liveMarkdown.openLive', (uri?: vscode.Uri) => this.openLive(uri, true)),
      vscode.commands.registerCommand('liveMarkdown.openSource', (uri?: vscode.Uri) => this.openSource(uri, true)),
      vscode.commands.registerCommand('liveMarkdown.openSplit', (uri?: vscode.Uri) => this.openSplit(uri)),
      vscode.commands.registerCommand('liveMarkdown.toggle', (uri?: vscode.Uri) => this.toggle(uri)),
      vscode.commands.registerCommand('liveMarkdown.disableDefault', (scope?: unknown) => this.setDefault(false, scope)),
      vscode.commands.registerCommand('liveMarkdown.enableDefault', (scope?: unknown) => this.setDefault(true, scope)),
    );
  }

  /** Resolve the Markdown document targeted by a command. */
  private targetUri(uri?: vscode.Uri): vscode.Uri | undefined {
    if (uri instanceof vscode.Uri) return uri;
    const live = this.provider.activeDocument;
    if (live) return live.uri;
    const active = vscode.window.activeTextEditor?.document;
    if (active && (active.languageId === 'markdown' || isMarkdownUri(active.uri))) return active.uri;
    const tabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (tabInput instanceof vscode.TabInputCustom || tabInput instanceof vscode.TabInputText) {
      if (isMarkdownUri(tabInput.uri)) return tabInput.uri;
    }
    return undefined;
  }

  /**
   * Replace the active tab in place with another editor type for the same resource, like
   * "Reopen Editor With...". This keeps unsaved changes without a "Save changes?" prompt, which
   * closing a dirty tab through `tabGroups.close` would trigger. Returns false when unavailable.
   */
  private async reopenActiveWith(target: vscode.Uri, kind: 'live' | 'text'): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('reopenActiveEditorWith', kind === 'live' ? VIEW_TYPE : 'default');
    } catch {
      return false;
    }
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (kind === 'live') return input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE && input.uri.toString() === target.toString();
    return input instanceof vscode.TabInputText && input.uri.toString() === target.toString();
  }

  private isActiveTab(target: vscode.Uri, kind: 'live' | 'text'): boolean {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return !!tab && tab === findTab(target, kind, vscode.window.tabGroups.activeTabGroup);
  }

  async openLive(uri: vscode.Uri | undefined, replace: boolean): Promise<void> {
    const target = this.targetUri(uri);
    if (!target) {
      void vscode.window.showInformationMessage('Live Markdown: no Markdown document to open.');
      return;
    }
    const group = vscode.window.tabGroups.activeTabGroup;
    if (replace && this.isActiveTab(target, 'text') && !findTab(target, 'live', group)) {
      if (await this.reopenActiveWith(target, 'live')) return;
    }
    const textTab = replace ? findTab(target, 'text', group) : undefined;
    await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE, group.viewColumn);
    if (textTab && !textTab.isDirty) await vscode.window.tabGroups.close(textTab, true);
  }

  async openSource(uri: vscode.Uri | undefined, replace: boolean): Promise<void> {
    const target = this.targetUri(uri);
    if (!target) return;
    const group = vscode.window.tabGroups.activeTabGroup;
    if (replace && this.isActiveTab(target, 'live') && !findTab(target, 'text', group)) {
      if (await this.reopenActiveWith(target, 'text')) return;
    }
    const liveTab = replace ? findTab(target, 'live', group) : undefined;
    await vscode.commands.executeCommand('vscode.openWith', target, 'default', group.viewColumn);
    if (liveTab && !liveTab.isDirty) await vscode.window.tabGroups.close(liveTab, true);
  }

  /** Native text editor and Live editor side by side. */
  async openSplit(uri?: vscode.Uri): Promise<void> {
    const target = this.targetUri(uri);
    if (!target) return;
    const group = vscode.window.tabGroups.activeTabGroup;
    const activeInput = group.activeTab?.input;
    const liveIsActive = activeInput instanceof vscode.TabInputCustom && activeInput.viewType === VIEW_TYPE;
    if (liveIsActive) {
      // Open the source next to the Live editor.
      await vscode.commands.executeCommand('vscode.openWith', target, 'default', {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      });
      return;
    }
    if (!findTab(target, 'text', group)) {
      await vscode.commands.executeCommand('vscode.openWith', target, 'default', group.viewColumn);
    }
    await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    });
  }

  async toggle(uri?: vscode.Uri): Promise<void> {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE) {
      await this.openSource(uri ?? input.uri, true);
    } else {
      await this.openLive(uri, true);
    }
  }

  /** scope is 'workspace' to write the workspace settings (used by tests); user settings otherwise. */
  async setDefault(enabled: boolean, scope?: unknown): Promise<void> {
    const target = scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const config = vscode.workspace.getConfiguration('workbench');
    const inspected = config.inspect<Record<string, string>>('editorAssociations');
    const existing = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
    const current = { ...(existing ?? {}) };
    for (const glob of MARKDOWN_GLOBS) {
      if (enabled) {
        if (current[glob] === 'default') delete current[glob];
      } else current[glob] = 'default';
    }
    await config.update('editorAssociations', Object.keys(current).length ? current : undefined, target);
    void vscode.window.showInformationMessage(
      enabled
        ? 'Live Markdown is now the default editor for Markdown files.'
        : 'Markdown files now open in the standard text editor. Use "Open in Live Editor" to switch.',
    );
  }
}
