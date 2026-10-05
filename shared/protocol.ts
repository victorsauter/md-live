/**
 * Messages exchanged between the extension host and the webview.
 *
 * Text sent over the wire always uses LF line endings; the host converts back to the
 * document's EOL when applying edits.
 */

export interface LiveMarkdownConfig {
  syntaxReveal: boolean;
  syncDelay: number;
  mermaidEnabled: boolean;
  maxWidth: string;
}

export interface InitMessage {
  type: 'init';
  text: string;
  version: number;
  config: LiveMarkdownConfig;
  documentUri: string;
  /** Webview URI of the document folder (with trailing slash), used to resolve relative images. */
  baseUri: string;
  /** Workspace-relative or absolute file name, for display. */
  fileName: string;
}

export interface UpdateMessage {
  type: 'update';
  text: string;
  version: number;
}

export interface AckMessage {
  type: 'ack';
  editId: number;
  version: number;
}

export interface RejectMessage {
  type: 'reject';
  editId: number;
  reason: string;
}

export interface ConfigMessage {
  type: 'config';
  config: LiveMarkdownConfig;
}

export interface FlushRequestMessage {
  type: 'flush';
  requestId: number;
}

export interface CommandMessage {
  type: 'command';
  command: 'undo' | 'redo' | 'find';
}

export type HostToWebviewMessage =
  | InitMessage
  | UpdateMessage
  | AckMessage
  | RejectMessage
  | ConfigMessage
  | FlushRequestMessage
  | CommandMessage;

export interface ReadyMessage {
  type: 'ready';
}

export interface EditMessage {
  type: 'edit';
  /** Full new document text (LF). */
  text: string;
  /** Document version the edit was computed against. */
  baseVersion: number;
  editId: number;
}

export interface FlushedMessage {
  type: 'flushed';
  requestId: number;
}

export interface OpenLinkMessage {
  type: 'openLink';
  href: string;
}

export interface SwitchModeMessage {
  type: 'switchMode';
  mode: 'source' | 'split';
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  detail?: string;
}

export interface LogMessage {
  type: 'log';
  message: string;
}

export type WebviewToHostMessage =
  | ReadyMessage
  | EditMessage
  | FlushedMessage
  | OpenLinkMessage
  | SwitchModeMessage
  | ErrorMessage
  | LogMessage;
