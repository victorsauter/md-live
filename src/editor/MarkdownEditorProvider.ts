import * as vscode from 'vscode';
import type {
  HostToWebviewMessage,
  MarkliveConfig,
  TestAction,
  TestProbe,
  TestResultMessage,
  WebviewToHostMessage,
} from '../../shared/protocol';
import { SyncSession } from './SyncSession';

export const VIEW_TYPE = 'marklive.editor';

export function readConfig(): MarkliveConfig {
  const config = vscode.workspace.getConfiguration('marklive');
  return {
    syntaxReveal: config.get<boolean>('syntaxReveal', true),
    syncDelay: config.get<number>('syncDelay', 120),
    mermaidEnabled: config.get<boolean>('mermaid.enabled', true),
    maxWidth: config.get<string>('maxWidth', '900px'),
  };
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

interface EditorEntry {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  session: SyncSession;
  ready: boolean;
  readyWaiters: Array<() => void>;
}

/**
 * Custom text editor rendering Markdown as an editable document (Live mode).
 *
 * The underlying `TextDocument` stays the source of truth: VS Code handles dirty state, save,
 * hot exit, revert and the file system. See README "Architecture" for the undo/redo decisions.
 */
export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly entries = new Set<EditorEntry>();
  private activeEntry: EditorEntry | undefined;
  private readonly output: vscode.LogOutputChannel;
  private readonly testWaiters = new Map<number, (message: TestResultMessage) => void>();
  private testId = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('Marklive', { log: true });
    context.subscriptions.push(
      this.output,
      vscode.workspace.onWillSaveTextDocument((e) => {
        const sessions = [...this.entries].filter((x) => x.document === e.document).map((x) => x.session);
        if (sessions.length > 0) e.waitUntil(Promise.all(sessions.map((s) => s.flush())));
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('marklive')) return;
        const config = readConfig();
        for (const entry of this.entries) void entry.panel.webview.postMessage({ type: 'config', config });
      }),
    );
  }

  static register(context: vscode.ExtensionContext): MarkdownEditorProvider {
    const provider = new MarkdownEditorProvider(context);
    context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
        webviewOptions: { retainContextWhenHidden: true, enableFindWidget: false },
        supportsMultipleEditorsPerDocument: true,
      }),
    );
    return provider;
  }

  /** The document of the Live editor that currently has focus, if any. */
  get activeDocument(): vscode.TextDocument | undefined {
    return this.activeEntry?.panel.active ? this.activeEntry.document : undefined;
  }

  get openEditorCount(): number {
    return this.entries.size;
  }

  log(message: string): void {
    this.output.info(message);
    if (this.context.extensionMode === vscode.ExtensionMode.Test) console.log(`[marklive] ${message}`);
  }

  /** Send a message to every Live editor showing `document` (used by tests and commands). */
  postToDocument(document: vscode.TextDocument, message: HostToWebviewMessage): void {
    for (const entry of this.entries) {
      if (entry.document === document) void entry.panel.webview.postMessage(message);
    }
  }

  postToActive(message: HostToWebviewMessage): void {
    const entry = this.activeEntry;
    if (entry?.panel.active) void entry.panel.webview.postMessage(message);
  }

  // ---- Hooks used by the integration tests -------------------------------------------------

  /** Resolves once a Live editor for `document` has loaded its webview. */
  whenReady(document: vscode.TextDocument, timeoutMs = 15000): Promise<boolean> {
    const entry = [...this.entries].find((x) => x.document === document);
    if (!entry) return Promise.resolve(false);
    if (entry.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      entry.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Process `text` exactly as if the webview of `document` had sent it. */
  async simulateWebviewEdit(document: vscode.TextDocument, text: string, baseVersion = document.version): Promise<void> {
    const entry = [...this.entries].find((x) => x.document === document);
    if (!entry) throw new Error('no Live editor for document');
    await entry.session.handleEdit({ type: 'edit', text, baseVersion, editId: Date.now() });
  }

  /** Run an automation action in the real webview of `document` (test mode only). */
  runWebviewTest(document: vscode.TextDocument, action: TestAction, timeoutMs = 10000): Promise<TestProbe> {
    const entry = [...this.entries].find((x) => x.document === document && x.ready);
    if (!entry) return Promise.reject(new Error('no ready Live editor for document'));
    const id = ++this.testId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.testWaiters.delete(id);
        reject(new Error(`webview test action timed out: ${action.kind}`));
      }, timeoutMs);
      this.testWaiters.set(id, (message) => {
        clearTimeout(timer);
        if (message.ok && message.result) resolve(message.result);
        else reject(new Error(message.error ?? 'webview test action failed'));
      });
      void entry.panel.webview.postMessage({ type: 'test', id, action } satisfies HostToWebviewMessage);
    });
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const webview = panel.webview;
    const docFolder = vscode.Uri.joinPath(document.uri, '..');
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), docFolder];
    for (const folder of vscode.workspace.workspaceFolders ?? []) roots.push(folder.uri);
    webview.options = { enableScripts: true, localResourceRoots: roots };
    webview.html = this.getHtml(webview);

    const post = (message: HostToWebviewMessage) => webview.postMessage(message);
    const session = new SyncSession(document, post, (m) => this.log(`[${vscode.workspace.asRelativePath(document.uri)}] ${m}`));
    const entry: EditorEntry = { panel, document, session, ready: false, readyWaiters: [] };
    this.entries.add(entry);
    if (panel.active) this.activeEntry = entry;

    const sendInit = () => {
      void post({
        type: 'init',
        text: session.text,
        version: session.version,
        config: readConfig(),
        documentUri: document.uri.toString(),
        baseUri: webview.asWebviewUri(docFolder).toString() + '/',
        fileName: vscode.workspace.asRelativePath(document.uri),
        testMode: this.context.extensionMode === vscode.ExtensionMode.Test,
      });
    };

    const subscriptions: vscode.Disposable[] = [
      webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
        switch (message.type) {
          case 'ready':
            sendInit();
            entry.ready = true;
            for (const resolve of entry.readyWaiters.splice(0)) resolve();
            break;
          case 'edit':
            void session.handleEdit(message);
            break;
          case 'flushed':
            session.handleFlushed(message.requestId);
            break;
          case 'openLink':
            void this.openLink(document, message.href);
            break;
          case 'switchMode':
            void vscode.commands.executeCommand(
              message.mode === 'source' ? 'marklive.openSource' : 'marklive.openSplit',
              document.uri,
            );
            break;
          case 'error':
            this.output.error(`${message.message}${message.detail ? `\n${message.detail}` : ''}`);
            void vscode.window.showErrorMessage(`Marklive: ${message.message}`);
            break;
          case 'log':
            this.log(message.message);
            break;
          case 'testResult': {
            const waiter = this.testWaiters.get(message.id);
            this.testWaiters.delete(message.id);
            waiter?.(message);
            break;
          }
        }
      }),
      panel.onDidChangeViewState(() => {
        if (panel.active) this.activeEntry = entry;
        else if (this.activeEntry === entry) this.activeEntry = undefined;
      }),
    ];

    panel.onDidDispose(() => {
      this.entries.delete(entry);
      if (this.activeEntry === entry) this.activeEntry = undefined;
      session.dispose();
      for (const d of subscriptions) d.dispose();
    });
  }

  private async openLink(document: vscode.TextDocument, href: string): Promise<void> {
    if (!href) return;
    if (href.startsWith('#')) {
      // In-document anchors are handled by the webview.
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    const [pathPart, fragment] = href.split('#', 2);
    let target: vscode.Uri;
    if (/^file:/i.test(pathPart)) target = vscode.Uri.parse(pathPart);
    else {
      const decoded = decodeURIComponent(pathPart);
      if (decoded.startsWith('/')) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        target = folder ? vscode.Uri.joinPath(folder.uri, decoded) : vscode.Uri.file(decoded);
      } else target = vscode.Uri.joinPath(document.uri, '..', decoded);
    }
    try {
      await vscode.workspace.fs.stat(target);
    } catch {
      void vscode.window.showWarningMessage(`Marklive: link target not found: ${href}`);
      return;
    }
    const withFragment = fragment ? target.with({ fragment }) : target;
    await vscode.commands.executeCommand('vscode.open', withFragment);
  }

  private getHtml(webview: vscode.Webview): string {
    const n = nonce();
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'main.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: http: data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${n}' ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style.toString()}">
<title>Marklive</title>
</head>
<body>
<div id="root"></div>
<script nonce="${n}">
  // Acquire the API once and report load/runtime errors to the extension host.
  window.vscodeApi = acquireVsCodeApi();
  window.__lmErrors = [];
  window.addEventListener('error', (e) => {
    if (e instanceof ErrorEvent) window.__lmErrors.push(String(e.message) + ' ' + (e.filename || ''));
    window.vscodeApi.postMessage({ type: 'log', message: 'webview error: ' + (e.message || e.type) + ' ' + (e.filename || (e.target && e.target.src) || '') });
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    window.__lmErrors.push('unhandled rejection: ' + String(e.reason && (e.reason.message || e.reason)));
    window.vscodeApi.postMessage({ type: 'log', message: 'webview unhandled rejection: ' + String(e.reason && (e.reason.stack || e.reason)) });
  });
</script>
<script type="module" nonce="${n}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}
