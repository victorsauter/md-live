/**
 * Messages exchanged between the extension host and the webview.
 *
 * Text sent over the wire always uses LF line endings; the host converts back to the
 * document's EOL when applying edits.
 */

export interface MarkliveConfig {
  syntaxReveal: boolean;
  syncDelay: number;
  mermaidEnabled: boolean;
  maxWidth: string;
}

export interface InitMessage {
  type: 'init';
  text: string;
  version: number;
  config: MarkliveConfig;
  documentUri: string;
  /** Webview URI of the document folder (with trailing slash), used to resolve relative images. */
  baseUri: string;
  /** Workspace-relative or absolute file name, for display. */
  fileName: string;
  /** Enables `test` messages (extension running in test mode only). */
  testMode?: boolean;
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
  config: MarkliveConfig;
}

export interface FlushRequestMessage {
  type: 'flush';
  requestId: number;
}

export interface CommandMessage {
  type: 'command';
  command: 'undo' | 'redo';
}

export interface FindMessage {
  type: 'find';
  query?: string;
}

/** Automation hooks used by the integration tests to drive the real webview editor. */
export type TestAction =
  | { kind: 'probe' }
  | { kind: 'moveFind'; delta: number }
  | { kind: 'replaceText'; needle: string; text: string; occurrence?: number }
  | { kind: 'toggleMark'; needle: string; mark: 'bold' | 'italic' | 'strike' | 'code'; occurrence?: number }
  | { kind: 'undo' }
  /** Focus the editor and put the cursor `offset` characters into the text `needle`. */
  | { kind: 'select'; needle: string; offset?: number; occurrence?: number };

export interface TestProbe {
  editable: boolean;
  status: string;
  textContent: string;
  mermaid: { blocks: number; svg: number; errors: number };
  highlightedTokens: number;
  /** Markdown markers currently revealed around the selection (Phase 12). */
  syntax: string[];
  find: { open: boolean; query: string; count: number; index: number; decorations: number; error: string | null };
  errors: string[];
}

export interface TestRequestMessage {
  type: 'test';
  id: number;
  action: TestAction;
}

export type HostToWebviewMessage =
  | InitMessage
  | TestRequestMessage
  | UpdateMessage
  | AckMessage
  | RejectMessage
  | ConfigMessage
  | FlushRequestMessage
  | FindMessage
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

export interface TestResultMessage {
  type: 'testResult';
  id: number;
  ok: boolean;
  result?: TestProbe;
  error?: string;
}

export type WebviewToHostMessage =
  | ReadyMessage
  | TestResultMessage
  | EditMessage
  | FlushedMessage
  | OpenLinkMessage
  | SwitchModeMessage
  | ErrorMessage
  | LogMessage;
