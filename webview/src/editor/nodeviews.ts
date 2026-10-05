/**
 * Plain DOM node views: code blocks (with language picker and Mermaid preview), images, task
 * list items and raw (non-editable Markdown) nodes.
 */
import type { NodeViewRendererProps } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Decoration, NodeView } from '@tiptap/pm/view';
import { TextSelection } from '@tiptap/pm/state';
import { renderMermaid } from './mermaid';
import type { EditorServices } from './services';

/** Spec flag of the node decoration added to the block that contains the selection. */
export const ACTIVE_SPEC = 'liveMarkdownActive';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function isActive(decorations: readonly Decoration[]): boolean {
  return decorations.some((d) => (d.spec as Record<string, unknown>)[ACTIVE_SPEC]);
}

function position(getPos: NodeViewRendererProps['getPos']): number | null {
  const pos = typeof getPos === 'function' ? getPos() : undefined;
  return typeof pos === 'number' ? pos : null;
}

const mermaidListeners = new Set<() => void>();

/** Re-render every Mermaid diagram (theme change). */
export function rerenderMermaidDiagrams(): void {
  for (const listener of mermaidListeners) listener();
}

export function codeBlockView(services: EditorServices) {
  return (props: NodeViewRendererProps): NodeView => {
    const { editor, getPos } = props;
    let current = props.node;
    let active = isActive(props.decorations);

    const dom = el('div', 'lm-code');
    const header = el('div', 'lm-code-header');
    header.contentEditable = 'false';
    const lang = el('input', 'lm-code-lang');
    lang.setAttribute('list', 'lm-languages');
    lang.placeholder = 'plain text';
    lang.spellcheck = false;
    lang.title = 'Language of the code block (info string)';
    const copy = el('button', 'lm-code-copy');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.title = 'Copy code';
    header.append(lang, copy);
    const pre = el('pre');
    const code = el('code');
    pre.append(code);
    const preview = el('div', 'lm-mermaid-preview');
    preview.contentEditable = 'false';
    preview.title = 'Click to edit the diagram';
    dom.append(header, pre, preview);

    const syncLanguage = () => {
      if (document.activeElement !== lang) lang.value = (current.attrs.language as string | null) ?? '';
      dom.dataset.language = (current.attrs.language as string | null) ?? '';
    };

    const commitLanguage = () => {
      const pos = position(getPos);
      const value = lang.value.trim();
      if (pos === null || ((current.attrs.language as string | null) ?? '') === value) return;
      editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'language', value || null));
    };

    const focusCode = (atEnd = false) => {
      const pos = position(getPos);
      if (pos === null) return;
      const target = atEnd ? pos + 1 + current.content.size : pos + 1;
      const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, target));
      editor.view.dispatch(tr);
      editor.view.focus();
    };

    lang.addEventListener('change', commitLanguage);
    lang.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        commitLanguage();
        focusCode();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        lang.value = (current.attrs.language as string | null) ?? '';
        focusCode();
      }
    });
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(current.textContent).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1200);
      });
    });

    // ---- Mermaid
    let renderTimer: ReturnType<typeof setTimeout> | undefined;
    let rendered: string | null = null;
    const isMermaid = () =>
      services.config().mermaidEnabled && ((current.attrs.language as string | null) ?? '').trim().toLowerCase() === 'mermaid';

    const render = (force = false) => {
      const mermaid = isMermaid();
      dom.classList.toggle('lm-is-mermaid', mermaid);
      if (!mermaid) {
        if (rendered !== null) preview.replaceChildren();
        rendered = null;
        return;
      }
      const source = current.textContent;
      if (!force && source === rendered) return;
      rendered = source;
      if (renderTimer) clearTimeout(renderTimer);
      renderTimer = setTimeout(
        () => {
          if (source.trim() === '') {
            preview.textContent = 'Empty diagram';
            preview.classList.add('lm-mermaid-empty');
            return;
          }
          void renderMermaid(source).then((result) => {
            if (rendered !== source) return;
            preview.classList.remove('lm-mermaid-empty');
            if ('svg' in result) {
              preview.classList.remove('lm-mermaid-error');
              preview.innerHTML = result.svg;
            } else {
              preview.classList.add('lm-mermaid-error');
              preview.textContent = `Mermaid syntax error: ${result.error}`;
            }
          });
        },
        active ? 350 : 0,
      );
    };
    const onThemeChange = () => render(true);
    mermaidListeners.add(onThemeChange);

    preview.addEventListener('mousedown', (event) => {
      event.preventDefault();
      focusCode(true);
    });

    const setActive = (decorations: readonly Decoration[]) => {
      active = isActive(decorations);
      dom.classList.toggle('lm-active', active);
    };

    syncLanguage();
    setActive(props.decorations);
    render();

    return {
      dom,
      contentDOM: code,
      update(node: PMNode, decorations: readonly Decoration[]) {
        if (node.type !== current.type) return false;
        current = node;
        syncLanguage();
        setActive(decorations);
        render();
        return true;
      },
      stopEvent(event: Event) {
        const target = event.target as Node | null;
        return !!target && (header.contains(target) || preview.contains(target));
      },
      ignoreMutation(mutation) {
        if (mutation.type === 'selection') return false;
        return !code.contains(mutation.target);
      },
      destroy() {
        if (renderTimer) clearTimeout(renderTimer);
        mermaidListeners.delete(onThemeChange);
      },
    };
  };
}

export function imageView(services: EditorServices) {
  return (props: NodeViewRendererProps): NodeView => {
    let current = props.node;
    const dom = el('span', 'lm-image');
    const img = el('img');
    img.draggable = false;
    dom.append(img);
    const set = (node: PMNode) => {
      const src = String(node.attrs.src ?? '');
      const resolved = services.resolveSrc(src);
      if (img.getAttribute('src') !== resolved) {
        dom.classList.remove('lm-broken');
        img.setAttribute('src', resolved);
      }
      img.alt = String(node.attrs.alt ?? '');
      dom.title = node.attrs.title ? String(node.attrs.title) : src;
      dom.dataset.alt = img.alt || src;
    };
    img.addEventListener('error', () => dom.classList.add('lm-broken'));
    set(current);
    return {
      dom,
      update(node: PMNode) {
        if (node.type !== current.type) return false;
        current = node;
        set(node);
        return true;
      },
    };
  };
}

export function listItemView() {
  return (props: NodeViewRendererProps): NodeView => {
    const { editor, getPos } = props;
    let current = props.node;
    const dom = el('li');
    const content = el('div', 'lm-li-content');
    let box: HTMLInputElement | null = null;
    const isTask = (node: PMNode) => node.attrs.checked !== null && node.attrs.checked !== undefined;
    if (isTask(current)) {
      dom.dataset.task = '';
      const label = el('label', 'lm-task');
      label.contentEditable = 'false';
      box = el('input');
      box.type = 'checkbox';
      box.addEventListener('mousedown', (event) => event.preventDefault());
      box.addEventListener('change', () => {
        const pos = position(getPos);
        if (pos === null || !box) return;
        editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'checked', box.checked));
      });
      label.append(box);
      dom.append(label);
    }
    dom.append(content);
    const set = (node: PMNode) => {
      if (box) {
        box.checked = node.attrs.checked === true;
        dom.dataset.checked = String(node.attrs.checked === true);
      }
    };
    set(current);
    return {
      dom,
      contentDOM: content,
      update(node: PMNode) {
        if (node.type !== current.type || isTask(node) !== isTask(current)) return false;
        current = node;
        set(node);
        return true;
      },
      stopEvent(event: Event) {
        return !!box && event.target === box;
      },
      ignoreMutation(mutation) {
        if (mutation.type === 'selection') return false;
        return !content.contains(mutation.target);
      },
    };
  };
}

const RAW_LABELS: Record<string, string> = {
  frontmatter: 'Front matter',
  html: 'HTML',
  definition: 'Link definition',
  footnoteDefinition: 'Footnote',
  math: 'Math',
};

/** Shared inline/block source editing for raw nodes. */
function sourceEditor(
  host: HTMLElement,
  multiline: boolean,
  initial: string,
  onDone: (value: string | null) => void,
): HTMLTextAreaElement | HTMLInputElement {
  const input = multiline ? el('textarea', 'lm-raw-editor') : el('input', 'lm-raw-editor');
  input.value = initial;
  input.spellcheck = false;
  if (input instanceof HTMLTextAreaElement) {
    input.rows = Math.max(2, initial.split('\n').length);
    input.addEventListener('input', () => (input.rows = Math.max(2, input.value.split('\n').length)));
  } else {
    input.size = Math.max(4, initial.length + 2);
    input.addEventListener('input', () => ((input as HTMLInputElement).size = Math.max(4, input.value.length + 2)));
  }
  let finished = false;
  const finish = (value: string | null) => {
    if (finished) return;
    finished = true;
    onDone(value);
  };
  input.addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    } else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      finish(input.value);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      finish(input.value);
    }
  });
  input.addEventListener('blur', () => finish(input.value));
  host.append(input);
  input.focus();
  return input;
}

export function rawBlockView(services: EditorServices) {
  return (props: NodeViewRendererProps): NodeView => {
    const { getPos, editor } = props;
    let current = props.node;
    const dom = el('div', 'lm-raw');
    dom.contentEditable = 'false';
    const label = el('div', 'lm-raw-label');
    const source = el('pre', 'lm-raw-source');
    dom.append(label, source);
    let editing = false;
    const set = (node: PMNode) => {
      const kind = String(node.attrs.kind ?? 'unknown');
      dom.dataset.kind = kind;
      label.textContent = RAW_LABELS[kind] ?? kind;
      label.title = 'Kept verbatim. Double-click to edit the Markdown source.';
      source.textContent = String(node.attrs.source ?? '');
    };
    const startEditing = () => {
      if (editing || !editor.isEditable) return;
      editing = true;
      dom.classList.add('lm-editing');
      source.hidden = true;
      sourceEditor(dom, true, String(current.attrs.source ?? ''), (value) => {
        editing = false;
        dom.classList.remove('lm-editing');
        dom.querySelector('.lm-raw-editor')?.remove();
        source.hidden = false;
        const pos = position(getPos);
        if (value !== null && pos !== null && value !== current.attrs.source) services.editRawSource(pos, value);
        else editor.view.focus();
      });
    };
    dom.addEventListener('dblclick', (event) => {
      event.preventDefault();
      startEditing();
    });
    set(current);
    return {
      dom,
      update(node: PMNode) {
        if (node.type !== current.type) return false;
        current = node;
        if (!editing) set(node);
        return true;
      },
      selectNode() {
        dom.classList.add('ProseMirror-selectednode');
      },
      deselectNode() {
        dom.classList.remove('ProseMirror-selectednode');
      },
      stopEvent(event: Event) {
        if (editing) return true;
        return event.type === 'dblclick';
      },
      ignoreMutation() {
        return true;
      },
    };
  };
}

function inlineDisplay(node: PMNode): { text: string; className: string } {
  const kind = String(node.attrs.kind ?? 'unknown');
  const source = String(node.attrs.source ?? '');
  switch (kind) {
    case 'wikilink': {
      const inner = source.replace(/^!?\[\[|\]\]$/g, '');
      const alias = inner.includes('|') ? inner.slice(inner.indexOf('|') + 1) : inner;
      return { text: alias, className: 'lm-wikilink' };
    }
    case 'footnoteReference':
      return { text: source.replace(/^\[\^|\]$/g, ''), className: 'lm-footnote-ref' };
    default:
      return { text: source, className: `lm-raw-inline-${kind}` };
  }
}

/** Target of a `[[wikilink]]`, as a relative Markdown file. */
export function wikilinkTarget(source: string): string {
  let inner = source.replace(/^!?\[\[|\]\]$/g, '');
  if (inner.includes('|')) inner = inner.slice(0, inner.indexOf('|'));
  let fragment = '';
  if (inner.includes('#')) {
    fragment = inner.slice(inner.indexOf('#'));
    inner = inner.slice(0, inner.indexOf('#'));
  }
  if (!inner) return fragment;
  const file = /\.[a-z0-9]+$/i.test(inner) ? inner : `${inner}.md`;
  return encodeURI(file) + fragment;
}

export function rawInlineView(services: EditorServices) {
  return (props: NodeViewRendererProps): NodeView => {
    const { getPos, editor } = props;
    let current = props.node;
    const dom = el('span', 'lm-raw-inline');
    dom.contentEditable = 'false';
    const text = el('span');
    dom.append(text);
    let editing = false;
    const set = (node: PMNode) => {
      const display = inlineDisplay(node);
      dom.className = `lm-raw-inline ${display.className}`;
      dom.dataset.kind = String(node.attrs.kind ?? 'unknown');
      dom.title = `${String(node.attrs.source ?? '')} — double-click to edit`;
      text.textContent = display.text;
    };
    dom.addEventListener('dblclick', (event) => {
      event.preventDefault();
      if (editing || !editor.isEditable) return;
      editing = true;
      text.hidden = true;
      sourceEditor(dom, false, String(current.attrs.source ?? ''), (value) => {
        editing = false;
        dom.querySelector('.lm-raw-editor')?.remove();
        text.hidden = false;
        const pos = position(getPos);
        if (value !== null && pos !== null && value !== current.attrs.source) services.editRawSource(pos, value);
        else editor.view.focus();
      });
    });
    set(current);
    return {
      dom,
      update(node: PMNode) {
        if (node.type !== current.type) return false;
        current = node;
        if (!editing) set(node);
        return true;
      },
      stopEvent(event: Event) {
        if (editing) return true;
        return event.type === 'dblclick';
      },
      ignoreMutation() {
        return true;
      },
    };
  };
}
