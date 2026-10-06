import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface FindMatch {
  from: number;
  to: number;
}

export interface FindResult {
  matches: FindMatch[];
  error: string | null;
}

export interface FindState extends FindOptions {
  query: string;
  matches: FindMatch[];
  activeIndex: number;
  error: string | null;
  highlighting: boolean;
}

type FindAction =
  | { type: 'set'; query: string; options?: FindOptions }
  | { type: 'hide' }
  | { type: 'move'; delta: number };

const DEFAULT_OPTIONS: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };
const WORD_CHAR = String.raw`\p{L}\p{N}_`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileSearch(query: string, options: FindOptions): RegExp {
  const source = options.regex ? query : escapeRegExp(query);
  const wordBounded = options.wholeWord ? String.raw`(?<![${WORD_CHAR}])(?:${source})(?![${WORD_CHAR}])` : source;
  return new RegExp(wordBounded, `gu${options.caseSensitive ? '' : 'i'}`);
}

interface TextRun {
  text: string;
  positions: number[];
}

function textRuns(node: PMNode, pos: number): TextRun[] {
  const runs: TextRun[] = [];
  let current: TextRun | undefined;
  node.forEach((child, offset) => {
    if (!child.isText) {
      current = undefined;
      return;
    }
    const text = child.text ?? '';
    const start = pos + 1 + offset;
    if (!current || current.positions[current.positions.length - 1] !== start) {
      current = { text: '', positions: [start] };
      runs.push(current);
    }
    current.text += text;
    for (let index = 0; index < text.length; index++) current.positions.push(start + index + 1);
  });
  return runs;
}

function nextCodePointLength(text: string, index: number): number {
  const codePoint = text.codePointAt(index);
  return codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
}

/** Search textblocks independently, joining adjacent text nodes across marks but not across atoms. */
export function findMatches(doc: PMNode, query: string, options: FindOptions = DEFAULT_OPTIONS): FindResult {
  if (!query) return { matches: [], error: null };
  let expression: RegExp;
  try {
    expression = compileSearch(query, options);
  } catch (error) {
    return { matches: [], error: error instanceof Error ? error.message : String(error) };
  }

  const matches: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    for (const run of textRuns(node, pos)) {
      expression.lastIndex = 0;
      let result: RegExpExecArray | null;
      while ((result = expression.exec(run.text)) !== null) {
        const length = result[0].length;
        if (length > 0) {
          const from = run.positions[result.index];
          const to = run.positions[result.index + length];
          if (from !== undefined && to !== undefined) matches.push({ from, to });
        } else {
          expression.lastIndex += nextCodePointLength(run.text, expression.lastIndex);
        }
      }
    }
    return false;
  });
  return { matches, error: null };
}

export const findPluginKey = new PluginKey<FindState>('markliveFind');

function activeIndex(index: number, length: number): number {
  return length === 0 ? 0 : ((index % length) + length) % length;
}

function createFindState(doc: PMNode, query: string, options: FindOptions, index: number, highlighting = true): FindState {
  const result = findMatches(doc, query, options);
  return {
    query,
    caseSensitive: options.caseSensitive,
    wholeWord: options.wholeWord,
    regex: options.regex,
    matches: result.matches,
    activeIndex: activeIndex(index, result.matches.length),
    error: result.error,
    highlighting,
  };
}

export function findPlugin(): Plugin<FindState> {
  return new Plugin<FindState>({
    key: findPluginKey,
    state: {
      init: (_, state) => createFindState(state.doc, '', DEFAULT_OPTIONS, 0, false),
      apply: (tr, previous) => {
        const action = tr.getMeta(findPluginKey) as FindAction | undefined;
        if (action?.type === 'set') {
          return createFindState(
            tr.doc,
            action.query,
            action.options ?? {
              caseSensitive: previous.caseSensitive,
              wholeWord: previous.wholeWord,
              regex: previous.regex,
            },
            0,
          );
        }
        if (action?.type === 'move') {
          return { ...previous, activeIndex: activeIndex(previous.activeIndex + action.delta, previous.matches.length) };
        }
        if (action?.type === 'hide') return { ...previous, highlighting: false };
        if (tr.docChanged) {
          return createFindState(tr.doc, previous.query, previous, previous.activeIndex, previous.highlighting);
        }
        return previous;
      },
    },
    props: {
      decorations(state) {
        const current = findPluginKey.getState(state);
        if (!current?.highlighting) return DecorationSet.empty;
        const decorations: Decoration[] = current.matches.map((match, index) =>
          Decoration.inline(
            match.from,
            match.to,
            { class: index === current.activeIndex ? 'lm-find-match lm-find-match-current' : 'lm-find-match' },
            { inclusiveStart: false, inclusiveEnd: false },
          ),
        );
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

export function setFindQuery(editor: Editor, query: string, options?: FindOptions): void {
  editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, { type: 'set', query, options } satisfies FindAction).setMeta('addToHistory', false));
}

export function moveFindMatch(editor: Editor, delta: number): void {
  editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, { type: 'move', delta } satisfies FindAction).setMeta('addToHistory', false));
}

export function hideFind(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, { type: 'hide' } satisfies FindAction).setMeta('addToHistory', false));
}

export function scrollToFindMatch(editor: Editor, match: FindMatch): void {
  const { view } = editor;
  if (!view.dom.isConnected) return;
  const { node } = view.domAtPos(match.from);
  const target = (node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement)?.closest<HTMLElement>(
    'p, h1, h2, h3, h4, h5, h6, pre, td, th, li',
  );
  const scroll = view.dom.closest<HTMLElement>('.lm-scroll');
  if (!scroll) return;
  const coords = view.coordsAtPos(match.from);
  const bounds = target?.getBoundingClientRect();
  const container = scroll.getBoundingClientRect();
  if (coords.top < container.top || (bounds && bounds.bottom < container.top)) scroll.scrollTop -= container.top - coords.top;
  else if (coords.bottom > container.bottom || (bounds && bounds.top > container.bottom)) scroll.scrollTop += coords.bottom - container.bottom;
}
