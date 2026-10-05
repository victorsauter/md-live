/**
 * Obsidian-style syntax reveal (Phase 12): shows the Markdown markers of the elements under the
 * selection as widget decorations (see `shared/markdown/syntax.ts`). Markers are read-only hints;
 * typing Markdown syntax is still handled by input rules. Nothing is shown while the editor does
 * not have the focus.
 */
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { syntaxMarkers, type SyntaxMarker } from '../../../shared/markdown/syntax';
import type { EditorServices } from './services';

/** Dispatch a transaction with `setMeta(syntaxRevealKey, { refresh: true })` to redraw the markers. */
export const syntaxRevealKey = new PluginKey('liveMarkdownSyntaxReveal');

function render(marker: SyntaxMarker): HTMLElement {
  const span = document.createElement('span');
  span.className = `lm-syntax lm-syntax-${marker.kind}${marker.block ? ' lm-syntax-block' : ''}`;
  span.textContent = marker.text;
  span.contentEditable = 'false';
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function build(state: EditorState, services: EditorServices): DecorationSet {
  if (!services.config().syntaxReveal) return DecorationSet.empty;
  const markers = syntaxMarkers(state, services.style());
  if (markers.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    state.doc,
    markers.map((marker) =>
      Decoration.widget(marker.pos, () => render(marker), {
        side: marker.side,
        key: `${marker.kind}:${marker.side}:${marker.text}`,
        ignoreSelection: true,
        marks: [],
      }),
    ),
  );
}

function hasFocus(view: EditorView): boolean {
  // Focus moving to a control inside the editor (node view inputs) keeps the reveal.
  return view.hasFocus() || view.dom.contains(view.dom.ownerDocument.activeElement);
}

export function syntaxRevealPlugin(services: EditorServices): Plugin {
  let current: EditorView | undefined;
  let cache: { state: EditorState; focused: boolean; decorations: DecorationSet } | undefined;
  const refresh = (view: EditorView) => {
    // Focus events are delivered after the change: redraw once the browser settled.
    setTimeout(() => {
      if (current !== view) return;
      view.dispatch(view.state.tr.setMeta(syntaxRevealKey, { refresh: true }).setMeta('addToHistory', false));
    });
    return false;
  };
  return new Plugin({
    key: syntaxRevealKey,
    view(view) {
      current = view;
      return {
        destroy: () => {
          current = undefined;
        },
      };
    },
    props: {
      decorations(state) {
        const focused = current ? hasFocus(current) : false;
        if (cache?.state !== state || cache.focused !== focused) {
          cache = { state, focused, decorations: focused ? build(state, services) : DecorationSet.empty };
        }
        return cache.decorations;
      },
      handleDOMEvents: { focus: refresh, blur: refresh },
    },
  });
}