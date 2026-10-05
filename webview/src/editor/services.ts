import type { LiveMarkdownConfig } from '../../../shared/protocol';
import type { DocStyle } from '../../../shared/markdown/types';

/** What the editor extensions need from the surrounding webview. */
export interface EditorServices {
  config(): LiveMarkdownConfig;
  style(): DocStyle | undefined;
  /** Webview URI to display an image whose Markdown `src` is given (the `src` itself is kept). */
  resolveSrc(src: string): string;
  /** Open a link target (Ctrl/Cmd+click). */
  openLink(href: string): void;
  /** Replace the Markdown source of a raw node (see `SyncClient.editRawSource`). */
  editRawSource(pos: number, source: string): boolean;
  /** Ask the UI to show the link editor (Mod-K). */
  requestLink(): void;
}
