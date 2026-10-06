/**
 * Owns the Tiptap editor and the sync client of one webview and routes host messages.
 * React components subscribe to it for toolbar/status rendering.
 */
import type { Editor } from '@tiptap/core';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { HostToWebviewMessage, MarkliveConfig } from '../../shared/protocol';
import { headingAnchors } from '../../shared/slug';
import { SyncClient, type SyncStatus } from '../../shared/sync/SyncClient';
import { createEditor } from './editor/createEditor';
import { findPluginKey, type FindMatch, type FindState } from './editor/find';
import { isDarkTheme, resetMermaidTheme } from './editor/mermaid';
import { rerenderMermaidDiagrams, wikilinkTarget } from './editor/nodeviews';
import type { EditorServices } from './editor/services';
import { syntaxRevealKey } from './editor/syntax';
import { runTestAction } from './testHooks';
import type { VsCodeApi } from './vscode';

export const DEFAULT_CONFIG: MarkliveConfig = {
  syntaxReveal: true,
  syncDelay: 120,
  mermaidEnabled: true,
  maxWidth: '900px',
};

export type ControllerEvent =
  | { type: 'status'; status: SyncStatus }
  | { type: 'loaded' }
  | { type: 'config' }
  | { type: 'requestLink' }
  | { type: 'find'; query?: string };

type Listener = (event: ControllerEvent) => void;

export class LiveEditorController {
  readonly element: HTMLDivElement;
  readonly editor: Editor;
  readonly client: SyncClient;
  config: MarkliveConfig = DEFAULT_CONFIG;
  baseUri = '';
  fileName = '';
  private readonly listeners = new Set<Listener>();
  private lastReportedError: string | null = null;
  private status: SyncStatus = { kind: 'synced' };
  private testMode = false;

  constructor(private readonly vscode: VsCodeApi) {
    this.element = document.createElement('div');
    this.element.className = 'lm-editor-host';
    const services: EditorServices = {
      config: () => this.config,
      style: () => this.client.style,
      resolveSrc: (src) => this.resolveSrc(src),
      openLink: (href) => this.openLink(href),
      editRawSource: (pos, source) => this.client.editRawSource(pos, source),
      requestLink: () => this.emit({ type: 'requestLink' }),
    };
    this.editor = createEditor({
      element: this.element,
      services,
      onTransaction: (tr: Transaction) => this.client?.onTransaction(tr),
    });
    this.editor.setEditable(false);
    this.client = new SyncClient({
      getState: () => this.editor.state,
      dispatch: (tr) => this.editor.view.dispatch(tr),
      setDoc: (doc: PMNode) => {
        // Start in the first textblock instead of node-selecting a leading raw block (front matter).
        const selection = TextSelection.findFrom(doc.resolve(0), 1, true) ?? undefined;
        const state = EditorState.create({ doc, selection, plugins: this.editor.state.plugins });
        this.editor.view.updateState(state);
      },
      post: (message) => this.vscode.postMessage(message),
      onStatus: (status) => this.onStatus(status),
    });
    this.observeTheme();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ControllerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private onStatus(status: SyncStatus): void {
    this.status = status;
    if (status.kind === 'error' && status.message !== this.lastReportedError) {
      this.lastReportedError = status.message;
      this.vscode.postMessage({ type: 'log', message: `edit not written (kept in the editor): ${status.message}` });
    } else if (status.kind !== 'error') this.lastReportedError = null;
    this.emit({ type: 'status', status });
  }

  handleMessage(message: HostToWebviewMessage): void {
    switch (message.type) {
      case 'init': {
        this.baseUri = message.baseUri;
        this.fileName = message.fileName;
        this.testMode = message.testMode === true;
        this.applyConfig(message.config);
        this.client.handleMessage(message);
        this.editor.setEditable(true);
        this.emit({ type: 'loaded' });
        break;
      }
      case 'config':
        this.applyConfig(message.config);
        break;
      case 'find':
        this.emit({ type: 'find', query: message.query });
        break;
      case 'flush':
        this.client.send();
        this.vscode.postMessage({ type: 'flushed', requestId: message.requestId });
        break;
      case 'test':
        if (!this.testMode) break;
        try {
          const result = runTestAction(this.editor, message.action, this.status.kind);
          this.vscode.postMessage({ type: 'testResult', id: message.id, ok: true, result });
        } catch (error) {
          this.vscode.postMessage({ type: 'testResult', id: message.id, ok: false, error: String(error) });
        }
        break;
      case 'command':
        if (message.command === 'undo') this.editor.commands.undo();
        else if (message.command === 'redo') this.editor.commands.redo();
        break;
      default:
        this.client.handleMessage(message);
        break;
    }
  }

  get findState(): FindState | undefined {
    return findPluginKey.getState(this.editor.state);
  }

  get currentFindMatch(): FindMatch | undefined {
    const state = this.findState;
    return state?.matches[state.activeIndex];
  }

  private applyConfig(config: MarkliveConfig): void {
    const previous = this.config;
    this.config = config;
    this.client.delay = Math.max(0, config.syncDelay);
    document.documentElement.style.setProperty('--lm-max-width', config.maxWidth || '900px');
    if (previous.mermaidEnabled !== config.mermaidEnabled) rerenderMermaidDiagrams();
    if (previous.syntaxReveal !== config.syntaxReveal && this.client.loaded) {
      this.editor.view.dispatch(this.editor.state.tr.setMeta(syntaxRevealKey, { refresh: true }));
    }
    this.emit({ type: 'config' });
  }

  private observeTheme(): void {
    let dark = isDarkTheme();
    new MutationObserver(() => {
      const next = isDarkTheme();
      if (next === dark) return;
      dark = next;
      resetMermaidTheme();
      rerenderMermaidDiagrams();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  resolveSrc(src: string): string {
    if (!src || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) {
      return /^(?:https?|data|blob|vscode-[a-z-]+):/i.test(src) ? src : src.startsWith('//') ? `https:${src}` : src;
    }
    try {
      return new URL(src.replace(/^\/+/, ''), this.baseUri || document.baseURI).toString();
    } catch {
      return src;
    }
  }

  openLink(href: string): void {
    if (href.startsWith('#')) {
      this.scrollToAnchor(decodeURIComponent(href.slice(1)));
      return;
    }
    if (href.startsWith('[[')) href = wikilinkTarget(href);
    this.vscode.postMessage({ type: 'openLink', href });
  }

  /** Move the caret to the heading whose GitHub-style anchor is `anchor`. */
  scrollToAnchor(anchor: string): boolean {
    const { doc } = this.editor.state;
    const headings: Array<{ pos: number; text: string }> = [];
    doc.descendants((node, pos) => {
      if (node.type.name === 'heading') headings.push({ pos, text: node.textContent });
      return node.isBlock && !node.isTextblock;
    });
    const anchors = headingAnchors(headings.map((h) => h.text));
    const index = anchors.indexOf(anchor.toLowerCase());
    if (index < 0) return false;
    const pos = headings[index]!.pos;
    const tr = this.editor.state.tr.setSelection(TextSelection.create(doc, pos + 1)).scrollIntoView();
    this.editor.view.dispatch(tr);
    (this.editor.view.nodeDOM(pos) as HTMLElement | null)?.scrollIntoView({ block: 'start' });
    this.editor.view.focus();
    return true;
  }

  dispose(): void {
    this.client.dispose();
    this.editor.destroy();
  }
}
