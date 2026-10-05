/**
 * Read-only validation of the lossless round trip on real Markdown repositories.
 *
 *   npm run validate:repos -- <folder> [<folder> ...] [--edits] [--semantic] [--verbose]
 *
 * For every .md / .markdown file it checks:
 *  - parse + serialize without edits returns the file byte for byte (always);
 *  - forcing the regeneration of every block yields a semantically equivalent document (--semantic);
 *  - changing one word in the first paragraph changes exactly one line (--edits).
 *
 * Files are only read, never written. Point it at a copy of the repository to be extra safe.
 * Nothing about the scanned content is stored; only paths and line numbers are printed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { toLf } from '../shared/eol';
import { canonicalDoc } from '../shared/markdown/canonical';
import { parseMarkdown } from '../shared/markdown/parse';
import { getMarkdownSchema } from '../shared/markdown/schema';
import { serializeMarkdown } from '../shared/markdown/serialize';

const schema = getMarkdownSchema();
const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash', 'dist', 'out']);

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const roots = args.filter((a) => !a.startsWith('--'));
const verbose = flags.has('--verbose');

if (roots.length === 0) {
  console.error('usage: npm run validate:repos -- <folder> [<folder> ...] [--edits] [--semantic] [--verbose]');
  process.exit(2);
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (/\.(md|markdown)$/i.test(entry.name)) yield path.join(dir, entry.name);
  }
}

function firstDifference(a: string, b: string): number {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) if (al[i] !== bl[i]) return i + 1;
  return -1;
}

function changedLineCount(a: string, b: string): number {
  const al = a.split('\n');
  const bl = b.split('\n');
  let s = 0;
  while (s < al.length && s < bl.length && al[s] === bl[s]) s++;
  let ea = al.length;
  let eb = bl.length;
  while (ea > s && eb > s && al[ea - 1] === bl[eb - 1]) {
    ea--;
    eb--;
  }
  return Math.max(ea - s, eb - s);
}

/** Position of the first word of the first plain paragraph text node, if any. */
function firstWord(doc: PMNode): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos, parent) => {
    if (found) return false;
    if (node.isText && parent?.type.name === 'paragraph' && node.marks.length === 0) {
      const match = /[A-Za-z]{3,}/.exec(node.text!);
      if (match) found = { from: pos + match.index, to: pos + match.index + match[0].length };
    }
    return true;
  });
  return found;
}

const stats = { files: 0, identical: 0, mismatch: 0, errors: 0, semantic: 0, semanticFail: 0, edits: 0, editFail: 0 };
const started = Date.now();

for (const root of roots) {
  if (!fs.existsSync(root)) {
    console.error(`not found: ${root}`);
    continue;
  }
  for (const file of walk(path.resolve(root))) {
    stats.files++;
    const rel = path.relative(root, file);
    let text = fs.readFileSync(file, 'utf8');
    if (text.startsWith('\uFEFF')) text = text.slice(1);
    const lf = toLf(text);
    try {
      const { doc, base } = parseMarkdown(lf, schema);
      const out = serializeMarkdown(doc, base);
      if (out === lf) stats.identical++;
      else {
        stats.mismatch++;
        console.log(`MISMATCH ${rel} (first difference at line ${firstDifference(lf, out)})`);
      }

      if (flags.has('--semantic')) {
        stats.semantic++;
        const regenerated = serializeMarkdown(doc, parseMarkdown('', schema).base);
        if (canonicalDoc(parseMarkdown(regenerated, schema).doc) !== canonicalDoc(doc)) {
          stats.semanticFail++;
          console.log(`SEMANTIC ${rel} (forced regeneration differs, first difference at line ${firstDifference(lf, regenerated)})`);
        }
      }

      if (flags.has('--edits')) {
        const word = firstWord(doc);
        if (word) {
          stats.edits++;
          const tr = EditorState.create({ doc, schema }).tr;
          tr.insertText('Zz', word.from, word.from + 1);
          const edited = serializeMarkdown(tr.doc, base);
          const changed = changedLineCount(lf, edited);
          if (changed !== 1) {
            stats.editFail++;
            console.log(`EDIT ${rel} (one-word edit changed ${changed} lines, first at line ${firstDifference(lf, edited)})`);
          }
        }
      }
      if (verbose) console.log(`ok ${rel}`);
    } catch (error) {
      stats.errors++;
      console.log(`ERROR ${rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

console.log(
  `\n${stats.files} files in ${((Date.now() - started) / 1000).toFixed(1)}s: ${stats.identical} byte-identical, ` +
    `${stats.mismatch} mismatches, ${stats.errors} errors` +
    (flags.has('--semantic') ? `; semantic ${stats.semantic - stats.semanticFail}/${stats.semantic}` : '') +
    (flags.has('--edits') ? `; one-line edits ${stats.edits - stats.editFail}/${stats.edits}` : ''),
);
process.exit(stats.mismatch + stats.errors > 0 ? 1 : 0);
