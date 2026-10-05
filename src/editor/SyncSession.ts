import * as vscode from 'vscode';
import type { EditMessage, HostToWebviewMessage } from '../../shared/protocol';
import { fromLf, toLf } from '../../shared/eol';
import { applyEdits, computeEdits, mergeEdits } from '../../shared/textdiff';

const KNOWN_TEXT_HISTORY = 50;


/**
 * Keeps one webview and one TextDocument in sync.
 *
 * - The TextDocument is the single source of truth.
 * - Webview edits carry the version they were computed against. If the document moved on in the
 *   meantime, the edit is rebased with a 3-way merge when the changes do not overlap, otherwise it
 *   is rejected and the webview receives the current text.
 * - Edits are applied as minimal `WorkspaceEdit`s (unchanged lines are never touched), converted to
 *   the document's EOL.
 * - Changes we applied ourselves are not echoed back to the webview.
 */
export class SyncSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly knownTexts = new Map<number, string>();
  private queue: Promise<void> = Promise.resolve();
  private applying = 0;
  private expectedText: string | undefined;
  private flushWaiters = new Map<number, () => void>();
  private nextFlushId = 1;
  private pendingUpdate: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    readonly document: vscode.TextDocument,
    private readonly post: (message: HostToWebviewMessage) => Thenable<boolean> | void,
    private readonly log: (message: string) => void,
  ) {
    this.remember();
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== this.document.uri.toString()) return;
        if (e.contentChanges.length === 0) return;
        this.onDocumentChanged();
      }),
    );
  }

  /** LF text of the document. */
  get text(): string {
    return toLf(this.document.getText());
  }

  get version(): number {
    return this.document.version;
  }

  private remember(): void {
    this.knownTexts.set(this.document.version, this.text);
    if (this.knownTexts.size > KNOWN_TEXT_HISTORY) {
      const oldest = Math.min(...this.knownTexts.keys());
      this.knownTexts.delete(oldest);
    }
  }

  private onDocumentChanged(): void {
    const text = this.text;
    this.remember();
    if (this.applying > 0 && this.expectedText !== undefined && text === this.expectedText) {
      // Our own edit: nothing to tell the webview, it already has this text.
      return;
    }
    this.scheduleUpdate();
  }

  private scheduleUpdate(): void {
    if (this.pendingUpdate) clearTimeout(this.pendingUpdate);
    this.pendingUpdate = setTimeout(() => {
      this.pendingUpdate = undefined;
      if (this.disposed) return;
      void this.post({ type: 'update', text: this.text, version: this.version });
    }, 10);
  }

  /** Called when the webview sends an edit. Edits are processed strictly in order. */
  handleEdit(message: EditMessage): Promise<void> {
    this.queue = this.queue.then(() => this.processEdit(message)).catch((err) => {
      this.log(`edit failed: ${String(err)}`);
    });
    return this.queue;
  }

  private async processEdit(message: EditMessage): Promise<void> {
    if (this.disposed) return;
    const currentText = this.text;
    let target = message.text;
    let rebased = false;
    if (message.baseVersion !== this.version) {
      const base = this.knownTexts.get(message.baseVersion);
      const merged =
        base === undefined ? null : mergeEdits(base, computeEdits(base, message.text), computeEdits(base, currentText));
      if (base === undefined || merged === null) {
        this.log(`edit ${message.editId} rejected: document changed (v${message.baseVersion} -> v${this.version})`);
        void this.post({ type: 'reject', editId: message.editId, reason: 'conflict' });
        void this.post({ type: 'update', text: currentText, version: this.version });
        return;
      }
      target = applyEdits(base, merged);
      rebased = true;
    }
    if (target !== currentText) {
      const ok = await this.applyText(target);
      if (!ok) {
        void this.post({ type: 'reject', editId: message.editId, reason: 'applyEdit failed' });
        void this.post({ type: 'update', text: this.text, version: this.version });
        return;
      }
    }
    void this.post({ type: 'ack', editId: message.editId, version: this.version });
    if (rebased) void this.post({ type: 'update', text: this.text, version: this.version });
  }

  /** Replace the document content with `lfText` using minimal edits. */
  private async applyText(lfText: string): Promise<boolean> {
    const doc = this.document;
    const oldText = doc.getText();
    const newText = fromLf(lfText, doc.eol === vscode.EndOfLine.CRLF);
    const edits = computeEdits(oldText, newText);
    if (edits.length === 0) return true;
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const e of edits) {
      workspaceEdit.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
    }
    this.applying++;
    this.expectedText = lfText;
    try {
      return await vscode.workspace.applyEdit(workspaceEdit);
    } finally {
      this.applying--;
      if (this.applying === 0) this.expectedText = undefined;
    }
  }

  /** Ask the webview to send any pending edit and wait until it has been applied. */
  flush(timeoutMs = 1500): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const id = this.nextFlushId++;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.flushWaiters.delete(id);
        resolve();
      }, timeoutMs);
      this.flushWaiters.set(id, () => {
        clearTimeout(timer);
        resolve();
      });
      void this.post({ type: 'flush', requestId: id });
    });
  }

  /** The webview reports it has no pending edit left (after sending it). */
  handleFlushed(requestId: number): void {
    const waiter = this.flushWaiters.get(requestId);
    if (!waiter) return;
    this.flushWaiters.delete(requestId);
    // Wait for queued edits to be applied before resolving.
    void this.queue.then(() => waiter());
  }

  dispose(): void {
    this.disposed = true;
    if (this.pendingUpdate) clearTimeout(this.pendingUpdate);
    for (const waiter of this.flushWaiters.values()) waiter();
    this.flushWaiters.clear();
    for (const d of this.disposables) d.dispose();
  }
}
