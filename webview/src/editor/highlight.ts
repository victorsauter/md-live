/**
 * Syntax highlighting of code blocks with lowlight, as ProseMirror decorations.
 *
 * The language is only used for display: when the info string has no language, the language is
 * auto-detected for highlighting but never written back to the Markdown.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { common, createLowlight } from 'lowlight';

export const lowlight = createLowlight(common);

const ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  cs: 'csharp',
  'c#': 'csharp',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  kt: 'kotlin',
  'objective-c': 'objectivec',
  html: 'xml',
  svg: 'xml',
  jsonc: 'json',
  dockerfile: 'bash',
  hcl: 'ini',
  toml: 'ini',
};

/** Languages offered by the language picker (any other info string is kept as typed). */
export const LANGUAGE_SUGGESTIONS = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'diff',
  'go',
  'graphql',
  'html',
  'ini',
  'java',
  'javascript',
  'json',
  'kotlin',
  'markdown',
  'mermaid',
  'php',
  'plaintext',
  'powershell',
  'python',
  'ruby',
  'rust',
  'scss',
  'shell',
  'sql',
  'swift',
  'typescript',
  'xml',
  'yaml',
];

export function resolveLanguage(language: string | null | undefined): string | null {
  if (!language) return null;
  const lower = language.toLowerCase();
  const name = ALIASES[lower] ?? lower;
  return lowlight.registered(name) ? name : null;
}

interface Span {
  from: number;
  to: number;
  className: string;
}

interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: string[] | string };
  children?: HastNode[];
}

function collect(nodes: HastNode[], classes: string[], offset: { value: number }, out: Span[]): void {
  for (const node of nodes) {
    if (node.type === 'text') {
      const length = node.value?.length ?? 0;
      if (classes.length > 0 && length > 0) out.push({ from: offset.value, to: offset.value + length, className: classes.join(' ') });
      offset.value += length;
    } else if (node.children) {
      const own = node.properties?.className;
      const next = own ? classes.concat(Array.isArray(own) ? own : [own]) : classes;
      collect(node.children, next, offset, out);
    }
  }
}

const AUTO_DETECT_LIMIT = 20_000;
const AUTO_DETECT_MIN_RELEVANCE = 7;
const cache = new WeakMap<PMNode, Span[]>();

function spansFor(node: PMNode): Span[] {
  let spans = cache.get(node);
  if (spans) return spans;
  spans = [];
  const text = node.textContent;
  const language = node.attrs.language as string | null;
  try {
    if (language && language.toLowerCase() === 'mermaid') {
      // Rendered as a diagram.
    } else {
      const name = resolveLanguage(language);
      let tree: { children: HastNode[] } | null = null;
      if (name) tree = lowlight.highlight(name, text) as unknown as { children: HastNode[] };
      else if (!language && text.length > 0 && text.length < AUTO_DETECT_LIMIT) {
        // Display-only guess; the info string is never rewritten. Low-confidence guesses are ignored.
        const auto = lowlight.highlightAuto(text) as unknown as { children: HastNode[]; data?: { relevance?: number } };
        if ((auto.data?.relevance ?? 0) >= AUTO_DETECT_MIN_RELEVANCE) tree = auto;
      }
      if (tree) collect(tree.children, [], { value: 0 }, spans);
    }
  } catch {
    spans = [];
  }
  cache.set(node, spans);
  return spans;
}

function buildDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') {
      for (const span of spansFor(node)) {
        decorations.push(Decoration.inline(pos + 1 + span.from, pos + 1 + span.to, { class: span.className }));
      }
      return false;
    }
    return !node.isTextblock && !node.isAtom;
  });
  return DecorationSet.create(doc, decorations);
}

export const highlightKey = new PluginKey<DecorationSet>('markliveHighlight');

export function highlightPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: highlightKey,
    state: {
      init: (_config, state) => buildDecorations(state.doc),
      apply: (tr, previous, _old, state) => (tr.docChanged ? buildDecorations(state.doc) : previous),
    },
    props: {
      decorations(state) {
        return highlightKey.getState(state);
      },
    },
  });
}
