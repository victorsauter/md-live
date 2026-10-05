/**
 * Obsidian-style syntax reveal (Phase 12): implemented later; currently a no-op plugin.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorServices } from './services';

export const syntaxRevealKey = new PluginKey('liveMarkdownSyntaxReveal');

export function syntaxRevealPlugin(_services: EditorServices): Plugin {
  return new Plugin({ key: syntaxRevealKey });
}
