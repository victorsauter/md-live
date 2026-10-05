/**
 * Phase 13 – Git compatibility. Runs the full write pipeline used by the extension
 * (document bytes -> LF -> parse -> edit -> serialize -> document EOL -> minimal text edits) and
 * checks the result with a real `git diff`.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '@tiptap/pm/state';
import { EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { fromLf, toLf } from '../../shared/eol';
import { canonicalDoc } from '../../shared/markdown/canonical';
import { parseMarkdown } from '../../shared/markdown/parse';
import { serializeMarkdown } from '../../shared/markdown/serialize';
import { applyEdits, computeEdits } from '../../shared/textdiff';
import { find, replaceText, schema } from './markdown/helpers';

const FIXTURES = path.resolve(__dirname, '../fixtures');
const BOM = '\uFEFF';

/** What VS Code gives the extension for a file: the text without BOM. */
function documentText(bytes: string): { text: string; bom: boolean } {
  return bytes.startsWith(BOM) ? { text: bytes.slice(1), bom: true } : { text: bytes, bom: false };
}

/** Full pipeline; returns the new file bytes (BOM restored as VS Code does on save). */
function pipeline(bytes: string, fn?: (tr: Transaction, doc: PMNode) => void): string {
  const { text, bom } = documentText(bytes);
  const crlf = text.includes('\r\n');
  const lf = toLf(text);
  const { doc, base } = parseMarkdown(lf, schema);
  const tr = EditorState.create({ doc, schema }).tr;
  fn?.(tr, tr.doc);
  const serialized = fromLf(serializeMarkdown(tr.doc, base), crlf);
  const edits = computeEdits(text, serialized);
  const applied = applyEdits(text, edits);
  expect(applied).toBe(serialized);
  if (!fn) expect(edits).toEqual([]);
  return (bom ? BOM : '') + applied;
}

let repo = '';
let counter = 0;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

/** Commit `before`, write `after`, return `git diff --numstat` as [added, removed]. */
function gitDiff(before: string, after: string): [number, number] {
  const name = `file-${counter++}.md`;
  fs.writeFileSync(path.join(repo, name), before, 'utf8');
  git('add', name);
  git('commit', '-q', '-m', name);
  fs.writeFileSync(path.join(repo, name), after, 'utf8');
  const out = git('diff', '--numstat', '--', name).trim();
  if (!out) return [0, 0];
  const [added, removed] = out.split('\t');
  return [Number(added), Number(removed)];
}

const fixtures = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.md'));
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const crlfOf = (text: string) => text.replace(/\r?\n/g, '\r\n');

describe('golden fixtures (byte identical)', () => {
  for (const name of fixtures) {
    it(name, () => {
      const bytes = read(name);
      expect(pipeline(bytes)).toBe(bytes);
    });
    it(`${name} (as CRLF)`, () => {
      const bytes = crlfOf(read(name));
      expect(pipeline(bytes)).toBe(bytes);
    });
  }
});

describe('forced regeneration of every block is semantically equivalent', () => {
  for (const name of fixtures) {
    it(name, () => {
      const lf = toLf(documentText(read(name)).text);
      const { doc } = parseMarkdown(lf, schema);
      const regenerated = serializeMarkdown(doc, parseMarkdown('', schema).base);
      expect(canonicalDoc(parseMarkdown(regenerated, schema).doc)).toBe(canonicalDoc(doc));
    });
  }
});

describe.skipIf(!hasGit)('git diff', () => {
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'live-md-git-'));
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
  });
  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('opening and saving without edits produces no diff', () => {
    for (const name of fixtures) {
      const bytes = read(name);
      expect(gitDiff(bytes, pipeline(bytes)), name).toEqual([0, 0]);
    }
  });

  it('one word in a CRLF document changes one line and keeps CRLF', () => {
    const bytes = read('crlf.md');
    const after = pipeline(bytes, replaceText('bold', 'strong'));
    expect(gitDiff(bytes, after)).toEqual([1, 1]);
    expect(after.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(after).toContain('**strong** text\r\n');
  });

  it('aligned table cell edit changes one line', () => {
    const bytes = read('crlf.md');
    expect(gitDiff(bytes, pipeline(bytes, replaceText('22', '23')))).toEqual([1, 1]);
  });

  it('adding a list item adds one line', () => {
    const bytes = read('showcase.md');
    const after = pipeline(bytes, (tr, doc) => {
      const { to } = find(doc, 'First item');
      tr.split(to, 2);
      tr.insertText('Inserted item', tr.mapping.map(to));
    });
    expect(gitDiff(bytes, after)).toEqual([1, 0]);
    expect(after).toContain('- First item\n- Inserted item\n- Second item');
  });

  it('toggling a task changes one line', () => {
    const bytes = read('showcase.md');
    const after = pipeline(bytes, (tr, doc) => {
      const $pos = doc.resolve(find(doc, 'Ship the extension').from);
      for (let d = $pos.depth; d > 0; d--) {
        if ($pos.node(d).type.name === 'listItem') {
          tr.setNodeAttribute($pos.before(d), 'checked', true);
          break;
        }
      }
    });
    expect(gitDiff(bytes, after)).toEqual([1, 1]);
    expect(after).toContain('- [x] Ship the extension');
  });

  it('editing the last line keeps the missing final newline', () => {
    const bytes = read('no-final-newline.md');
    const after = pipeline(bytes, replaceText('Last paragraph', 'Final paragraph'));
    expect(after.endsWith('Final paragraph without newline')).toBe(true);
    expect(gitDiff(bytes, after)).toEqual([1, 1]);
  });

  it('BOM is preserved', () => {
    const bytes = read('bom.md');
    const after = pipeline(bytes, replaceText('Text after', 'Words after'));
    expect(after.startsWith(BOM)).toBe(true);
    expect(gitDiff(bytes, after)).toEqual([1, 1]);
  });

  it('edits next to raw constructs leave them untouched', () => {
    const bytes = read('edge-cases.md');
    for (const [needle, replacement] of [
      ['continuation paragraph', 'continued paragraph'],
      ['Term with footnote', 'Word with footnote'],
      ['plus bullet', 'plus marker'],
      ['Wiki:', 'Wikis:'],
      ['Inline', 'Inline keys'],
      ['ordered task', 'numbered task'],
    ] as const) {
      const after = pipeline(bytes, replaceText(needle, replacement));
      expect(gitDiff(bytes, after), needle).toEqual([1, 1]);
    }
  });
});
