import { EditorState, TextSelection, type Command } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { joinBackward, joinForward, lift, setBlockType, wrapIn, deleteSelection, splitBlock } from '@tiptap/pm/commands';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from '@tiptap/pm/schema-list';
import { parseMarkdown } from '../../../shared/markdown/parse';
import { serializeMarkdown } from '../../../shared/markdown/serialize';
import { canonicalDoc } from '../../../shared/markdown/canonical';
import { schema } from './helpers';

export const SAMPLES = [
  '# Title\n\nSome *text* and **bold** with `code` and [a link](https://x.y).\n\n- a\n- [ ] b\n  - c\n\n1. one\n2. two\n',
  '> quote *a*\n> b\n\n| h1 | h2 |\n| --- | :-: |\n| x | y |\n| z |\n\n```py\nprint(1)\n```\n',
  '---\nk: v\n---\n\nPara with [[Wiki]] and $m$ and <b>html</b> and a note[^n].\n\n[^n]: Note.\n\n[r]: https://r\n',
  'Setext\n===\n\n* x\n\n* y\n\n    code\n\n***\n\n_u_ __s__ ~~d~~ line  \nbreak\n',
  '1) first\n2) second\n   continued\n\n   para\n\n> - q1\n>   - q2\n\nSee [docs][d] and ![img][i].\n\n[d]: https://d "D"\n[i]: /i.png\n',
];

const CHARS = ['a', 'b', ' ', '*', '_', '`', '[', ']', '(', ')', '#', '>', '-', '+', '1.', '|', '\\', '<', '&', '!', '$', '~', 'é', '🎉', '\n', 'x', '  ', '=', '[[', ']]', '<br>'];

export function prng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

function textPositions(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (node.type.name === 'codeBlock') {
        out.push(pos + 1, pos + 1 + node.content.size);
        return false;
      }
      for (let i = 0; i <= node.content.size; i++) out.push(pos + 1 + i);
      return false;
    }
    return true;
  });
  return out;
}

const n = schema.nodes;
const COMMANDS: Array<[string, Command]> = [
  ['splitBlock', splitBlock],
  ['splitListItem', splitListItem(n.listItem!)],
  ['sinkListItem', sinkListItem(n.listItem!)],
  ['liftListItem', liftListItem(n.listItem!)],
  ['heading2', setBlockType(n.heading!, { level: 2 })],
  ['paragraph', setBlockType(n.paragraph!)],
  ['codeBlock', setBlockType(n.codeBlock!)],
  ['blockquote', wrapIn(n.blockquote!)],
  ['bulletList', wrapInList(n.bulletList!)],
  ['orderedList', wrapInList(n.orderedList!)],
  ['lift', lift],
  ['joinBackward', joinBackward],
  ['joinForward', joinForward],
  ['delete', deleteSelection],
];

function randomInsert(rand: () => number): string {
  let insert = '';
  const count = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < count; i++) insert += CHARS[Math.floor(rand() * CHARS.length)];
  return insert;
}

export function fuzz(sample: string, seed: number, rounds: number, steps: number) {
  const rand = prng(seed);
  for (let round = 0; round < rounds; round++) {
    const { doc, base } = parseMarkdown(sample, schema);
    let state = EditorState.create({ doc, schema });
    const log: string[] = [];
    for (let step = 0; step < steps; step++) {
      const positions = textPositions(state.doc);
      if (!positions.length) break;
      const pos = positions[Math.floor(rand() * positions.length)]!;
      const op = rand();
      let next = state;
      try {
        if (op < 0.4) {
          const tr = state.tr;
          const $pos = tr.doc.resolve(pos);
          const parent = $pos.parent.type.name;
          let insert = randomInsert(rand);
          if (parent !== 'paragraph' && parent !== 'codeBlock') insert = insert.replace(/\n/g, ' ');
          if (parent === 'paragraph' && insert.includes('\n')) {
            let at = pos;
            insert.split('\n').forEach((part, i) => {
              if (i > 0) {
                tr.insert(at, n.hardBreak!.create());
                at += 1;
              }
              if (part) {
                tr.insertText(part, at);
                at += part.length;
              }
            });
          } else {
            tr.insertText(insert, pos);
          }
          log.push(`insert ${JSON.stringify(insert)} at ${pos}`);
          next = state.apply(tr);
        } else if (op < 0.55) {
          const $pos = state.doc.resolve(pos);
          const end = Math.min($pos.end(), pos + 1 + Math.floor(rand() * 5));
          if (end > pos) {
            next = state.apply(state.tr.delete(pos, end));
            log.push(`delete ${pos}-${end}`);
          }
        } else if (op < 0.7) {
          const $pos = state.doc.resolve(pos);
          const end = Math.min($pos.end(), pos + 1 + Math.floor(rand() * 6));
          const marks = [schema.marks.bold!, schema.marks.italic!, schema.marks.strike!, schema.marks.code!, schema.marks.link!];
          const mark = marks[Math.floor(rand() * marks.length)]!;
          if (end > pos && $pos.parent.type.name !== 'codeBlock') {
            const add = rand() < 0.6;
            const tr = add ? state.tr.addMark(pos, end, mark.create(mark.name === 'link' ? { href: 'https://l.k' } : null)) : state.tr.removeMark(pos, end, mark);
            next = state.apply(tr);
            log.push(`${add ? 'add' : 'remove'} ${mark.name} ${pos}-${end}`);
          }
        } else {
          const [name, command] = COMMANDS[Math.floor(rand() * COMMANDS.length)]!;
          let sel = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
          if (name === 'delete') {
            const positions2 = textPositions(state.doc);
            const other = positions2[Math.floor(rand() * positions2.length)]!;
            sel = state.apply(state.tr.setSelection(TextSelection.create(state.doc, Math.min(pos, other), Math.max(pos, other))));
          }
          command(sel, (tr) => {
            next = sel.apply(tr);
          });
          log.push(`${name} at ${pos}`);
        }
      } catch {
        continue;
      }
      state = next;
      let text: string;
      try {
        text = serializeMarkdown(state.doc, base);
      } catch (error) {
        throw new Error(`${(error as Error).message}\nsample=${JSON.stringify(sample)}\nsteps=${log.join('; ')}\ndoc=${JSON.stringify(state.doc.toJSON())}`, { cause: error });
      }
      const actual = canonicalDoc(parseMarkdown(text, schema).doc);
      const expected = canonicalDoc(state.doc);
      if (actual !== expected) {
        throw new Error(`Mismatch\nsample=${JSON.stringify(sample)}\nsteps=${log.join('; ')}\ntext=${JSON.stringify(text)}\nactual=${actual}\nexpected=${expected}`);
      }
    }
  }
}

