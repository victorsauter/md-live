/**
 * Webview side of the synchronisation with the extension host (DOM-free, unit tested).
 *
 * - The host's TextDocument is the source of truth. Local edits are serialized with the lossless
 *   serializer against the source the editor was loaded from, then sent as full text with the
 *   document version they are based on; the host applies a minimal WorkspaceEdit.
 * - External changes (`update`) are applied with `reconcile`, which only replaces the top-level
 *   blocks that differ, outside of the undo history.
 * - While an edit is in flight, updates are deferred: the host acknowledges with the version that
 *   contains our edit, and sends a fresh update if it had to rebase it.
 * - Nothing is sent when the document cannot be serialized without changing its meaning.
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { parseMarkdown } from '../markdown/parse';
import { rebind, reconcile } from '../markdown/reconcile';
import { serializeMarkdown } from '../markdown/serialize';
import type { DocStyle, SourceBase } from '../markdown/types';
import type { EditMessage, HostToWebviewMessage, UpdateMessage } from '../protocol';

/** Transaction meta set on changes that come from the host (never sent back). */
export const EXTERNAL_META = 'liveMarkdownExternal';

export type SyncStatus =
  | { kind: 'synced' }
  | { kind: 'pending' }
  | { kind: 'error'; message: string };

export interface SyncHost {
  getState(): EditorState;
  dispatch(tr: Transaction): void;
  /** Replace the editor state with a fresh one for `doc` (initial load, no history). */
  setDoc(doc: PMNode): void;
  post(message: EditMessage): void;
  onStatus?(status: SyncStatus): void;
}

export class SyncClient {
  private base: SourceBase | null = null;
  private version = 0;
  /** Text the host has, or will have once in-flight edits are applied, for the current state. */
  private knownText: string | null = null;
  private inFlight = 0;
  private deferred: UpdateMessage | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private editId = 0;
  private applying = false;
  private status: SyncStatus = { kind: 'synced' };

  /** Debounce delay (ms) before local edits are sent. */
  delay = 120;

  constructor(private readonly host: SyncHost) {}

  get loaded(): boolean {
    return this.base !== null;
  }

  get documentVersion(): number {
    return this.version;
  }

  get style(): DocStyle | undefined {
    return this.base?.style;
  }

  get currentStatus(): SyncStatus {
    return this.status;
  }

  get hasPendingChanges(): boolean {
    return this.dirty || this.inFlight > 0;
  }

  /** Load `text` as a new document (initial load or full reset). */
  load(text: string, version: number): void {
    const { doc, base } = parseMarkdown(text, this.host.getState().schema);
    this.clearTimer();
    this.applying = true;
    try {
      this.host.setDoc(doc);
    } finally {
      this.applying = false;
    }
    rebind(this.host.getState().doc, base);
    this.base = base;
    this.version = version;
    this.knownText = text;
    this.inFlight = 0;
    this.deferred = null;
    this.dirty = false;
    this.setStatus({ kind: 'synced' });
  }

  /** Must be called for every transaction dispatched to the editor. */
  onTransaction(tr: Transaction): void {
    if (this.applying || !tr.docChanged || tr.getMeta(EXTERNAL_META)) return;
    this.dirty = true;
    if (this.status.kind !== 'error') this.setStatus({ kind: 'pending' });
    this.schedule();
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.send();
    }, this.delay);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Send pending local changes now. Returns false when they cannot be written (the editor keeps
   * them and retries on the next change).
   */
  send(): boolean {
    this.clearTimer();
    if (!this.dirty || !this.base) return true;
    let text: string;
    try {
      text = serializeMarkdown(this.host.getState().doc, this.base);
    } catch (error) {
      this.setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      return false;
    }
    this.dirty = false;
    this.postText(text);
    if (this.inFlight === 0) this.setStatus({ kind: 'synced' });
    return true;
  }

  private postText(text: string): void {
    if (text === this.knownText) return;
    this.knownText = text;
    this.inFlight++;
    this.setStatus({ kind: 'pending' });
    this.host.post({ type: 'edit', text, baseVersion: this.version, editId: ++this.editId });
  }

  /**
   * Replace the Markdown source of the raw node at `pos` (HTML, front matter, math...). The
   * source is written verbatim and the document is then re-parsed, so the node may turn into
   * regular content.
   */
  editRawSource(pos: number, source: string): boolean {
    if (!this.base || !this.send()) return false;
    const state = this.host.getState();
    const node = state.doc.nodeAt(pos);
    if (!node || (node.type.name !== 'rawBlock' && node.type.name !== 'rawInline')) return false;
    if (node.attrs.source === source) return true;
    this.applying = true;
    try {
      this.host.dispatch(state.tr.setNodeAttribute(pos, 'source', source));
    } finally {
      this.applying = false;
    }
    let text: string;
    try {
      text = serializeMarkdown(this.host.getState().doc, this.base, { trustRaw: true });
    } catch (error) {
      this.setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      return false;
    }
    this.postText(text);
    this.applyText(text);
    return true;
  }

  handleMessage(message: HostToWebviewMessage): void {
    switch (message.type) {
      case 'init':
        this.load(message.text, message.version);
        break;
      case 'update':
        this.onUpdate(message);
        break;
      case 'ack':
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.version = Math.max(this.version, message.version);
        if (this.inFlight === 0) {
          if (!this.dirty && this.status.kind !== 'error') this.setStatus({ kind: 'synced' });
          this.processDeferred();
        }
        break;
      case 'reject':
        this.inFlight = Math.max(0, this.inFlight - 1);
        // The host follows up with an update carrying its current text.
        this.knownText = null;
        if (this.inFlight === 0) this.processDeferred();
        break;
      default:
        break;
    }
  }

  private processDeferred(): void {
    const deferred = this.deferred;
    this.deferred = null;
    if (deferred && deferred.version > this.version) this.onUpdate(deferred);
  }

  private onUpdate(message: UpdateMessage): void {
    if (!this.base) {
      this.load(message.text, message.version);
      return;
    }
    if (message.version < this.version) return;
    if (this.inFlight > 0) {
      this.deferred = message;
      return;
    }
    if (this.dirty) {
      // Send local changes first: the host rebases them on its current text.
      if (this.send() && this.inFlight > 0) {
        this.deferred = message;
        return;
      }
      // Changes that cannot be serialized are dropped in favour of the external text.
      this.dirty = false;
    }
    this.version = message.version;
    if (message.text === this.knownText) return;
    this.applyText(message.text);
    this.setStatus({ kind: 'synced' });
  }

  /** Make the editor show the parse of `text`, keeping unchanged blocks (and the selection). */
  private applyText(text: string): void {
    const { base, tr } = reconcile(this.host.getState(), text);
    if (tr) {
      this.applying = true;
      try {
        this.host.dispatch(tr);
      } finally {
        this.applying = false;
      }
    }
    rebind(this.host.getState().doc, base);
    this.base = base;
    this.knownText = text;
  }

  private setStatus(status: SyncStatus): void {
    const same =
      status.kind === this.status.kind &&
      (status.kind !== 'error' || (this.status.kind === 'error' && this.status.message === status.message));
    this.status = status;
    if (!same) this.host.onStatus?.(status);
  }

  dispose(): void {
    this.clearTimer();
  }
}
