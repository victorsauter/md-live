# Marklive — Live Markdown Editor

**Marklive** is a Typora/Obsidian-style **live** Markdown editor for VS Code. Markdown files open in
a rich editing view where formatting is rendered as you type, while the file on disk stays plain
Markdown that remains readable, diff-friendly and **byte-for-byte identical** wherever you did not
edit.

## Features

* **Edit the rendered document**: headings, paragraphs, **bold**, *italic*, ~~strikethrough~~,
  `inline code`, links, images, blockquotes, bullet / numbered / task lists (nested), horizontal
  rules, GFM tables and fenced code blocks.
* **Obsidian-style syntax reveal**: the Markdown markers of the element under the cursor are shown
  around it (`**bold**`, `## Heading`, `[text](https://…)`, `` `code` ``), using the markers of your file
  (`__` vs `**`, reference links, `<autolinks>`). Turn it off with `marklive.syntaxReveal`.
* **Three modes**: *Live* (rendered editor), *Source* (VS Code's native text editor) and *Split*
  (both side by side, kept in sync through the same `TextDocument`).
* **Tables**: Tab / Shift+Tab between cells, Enter to move down, toolbar and context menu to add or
  delete rows and columns, change the column alignment or delete the table. Untouched rows keep
  their exact formatting; an edited row is padded like the rest of the table.
* **Code blocks**: syntax highlighting (lowlight / highlight.js, theme-aware), language picker,
  Tab / Shift+Tab indentation. The language is auto-detected for display only and never written.
* **Mermaid**: ```` ```mermaid ```` blocks render as diagrams (loaded on demand, light/dark theme,
  `securityLevel: strict`); click a diagram to edit its source with a live preview, errors are
  shown inline.
* **Keeps what it does not understand**: front matter, HTML, footnotes, reference definitions,
  `[[wikilinks]]`, math and other constructs are shown as read-only (or source-editable) raw blocks
  and written back verbatim.
* **VS Code integration**: dark, light and high-contrast themes (VS Code CSS variables), dirty
  state, save, auto save, hot exit, undo/redo, external changes (git checkout, other editors,
  formatters) and native diff views keep working.

## Usage

Markdown files (`*.md`, `*.markdown`) open in the Live editor by default.

| Command | Default shortcut | Description |
|---|---|---|
| `Marklive: Open in Live Editor` | | Reopen the file in the Live editor |
| `Marklive: Open in Source Editor` | | Reopen the file in VS Code's text editor |
| `Marklive: Open Source and Live Side by Side` | | Split mode |
| `Marklive: Toggle Live / Source` | `Ctrl+Shift+M` / `Cmd+Shift+M` | Switch between Live and Source |
| `Marklive: Disable Marklive as Default Editor` | | Open Markdown files in the text editor by default (`workbench.editorAssociations`) |
| `Marklive: Enable Marklive as Default Editor` | | Restore the Live editor as default |

Switching modes replaces the tab in place (like *Reopen Editor With…*), so unsaved changes are kept
without a "Save changes?" prompt. The Live editor toolbar also has *Live / Source / Split* buttons.

### Editing shortcuts (Live mode)

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+B`, `Ctrl/Cmd+I`, `Ctrl/Cmd+Shift+S`, `Ctrl/Cmd+E` | Bold, italic, strikethrough, inline code |
| `Ctrl/Cmd+K` | Insert / edit link |
| `Ctrl/Cmd+Click` | Open link (relative Markdown links open in VS Code) |
| `Ctrl/Cmd+Alt+1…6`, `Ctrl/Cmd+Alt+0` | Heading level, paragraph |
| `Ctrl/Cmd+Shift+8`, `Ctrl/Cmd+Shift+7`, `Ctrl/Cmd+Shift+9` | Bullet, numbered, task list |
| `Ctrl/Cmd+Shift+B`, `Ctrl/Cmd+Alt+C` | Blockquote, code block |
| `Tab` / `Shift+Tab` | Indent / outdent list item, next / previous table cell, indent code |
| `Ctrl/Cmd+Z`, `Ctrl/Cmd+Y` / `Ctrl/Cmd+Shift+Z` | Undo, redo |
| `Ctrl/Cmd+S` | Save (pending edits are flushed first) |

Markdown input rules work as you type: `# `, `- `, `1. `, `> `, ```` ``` ````, `**bold**`,
`*italic*`, `` `code` ``, `---`, `[ ] ` …  Pasting Markdown text inserts formatted content; copying
puts Markdown on the clipboard.

### Settings

| Setting | Default | Description |
|---|---|---|
| `marklive.syntaxReveal` | `true` | Reveal Markdown syntax around the element under the cursor |
| `marklive.syncDelay` | `120` | Delay (ms) before Live edits are written to the text document |
| `marklive.mermaid.enabled` | `true` | Render Mermaid code blocks as diagrams |
| `marklive.maxWidth` | `900px` | Maximum width of the editing column |

## Architecture

```
┌──────────────── Extension host (Node) ────────────────┐        ┌──────────── Webview ────────────┐
│ MarkdownEditorProvider (CustomTextEditorProvider)     │ init   │ React + Tiptap/ProseMirror      │
│  └─ SyncSession per panel                             │ ─────► │  parse(markdown) → PM doc       │
│      • TextDocument is the single source of truth     │ update │  + source map (node → bytes)    │
│      • applies minimal WorkspaceEdits (text diff)     │ ◄───── │  serialize = patch original     │
│      • rebases stale edits, anti-loop, flush on save  │ edit   │  text block by block            │
└───────────────────────────────────────────────────────┘        └─────────────────────────────────┘
```

* `src/` — extension host: custom editor provider, sync session, mode commands.
* `shared/` — code shared by both sides: Markdown parser / serializer (`shared/markdown`), sync
  protocol and client, text diff, EOL helpers.
* `webview/` — React UI (toolbar, dialogs, status) and the Tiptap editor (node views, highlighting,
  Mermaid, table behaviour, syntax reveal).
* Two esbuild bundles: `dist/extension.js` (Node, CommonJS) and `dist/webview/*` (browser); Mermaid
  is split into a separate chunk loaded on demand.

* **Live mode** is a `CustomTextEditorProvider` registered with priority `default` for `*.md` and
  `*.markdown`. The provider never owns the document: VS Code's `TextDocument` stays the source of
  truth, so dirty state, save, hot exit, auto save, git and other extensions keep working.
* **Source mode** is VS Code's native text editor (`vscode.openWith(uri, 'default')`).
  **Split mode** shows the native editor and the Live editor side by side (`ViewColumn.Beside`).

### Lossless round-trip

The webview keeps the original Markdown and a source map from document nodes to byte ranges
(remark / micromark positions; node identity through a `WeakMap`). On every change:

1. Unchanged blocks (same ProseMirror node object) reuse their original bytes, including the blank
   lines and container prefixes (`> `, list indentation) around them.
2. Changed textblocks are patched at the finest safe granularity: edited text runs are spliced into
   the original line, so changing one word changes exactly one line of `git diff`.
3. Other changed blocks are regenerated with `mdast-util-to-markdown`, using the document's detected
   style (bullet character, emphasis markers, fence, thematic break, hard break, table padding).
4. Line endings (LF/CRLF), a missing final newline and a byte order mark are preserved.
5. The result is verified: when not every block was reused, the output is parsed again and compared
   with the editor document. If serialization or verification fails, **nothing is written** and the
   status bar of the editor shows the error.

### Undo/redo, save and diff (Phase 2b spike)

These behaviours were verified with integration tests (`test/integration/suite/spike.test.ts`):

* **Undo/redo inside the editor** uses ProseMirror's history. The webview stops propagation of
  `Ctrl/Cmd+Z`, `Ctrl/Cmd+Y` and `Ctrl/Cmd+Shift+Z` so VS Code's webview host does not forward them to
  the workbench. **Edit ▸ Undo** (or the `undo` command while the Live tab is focused but the
  webview is not) routes to the `TextDocument` undo stack; the result reaches the webview as an
  external update. Both stacks therefore stay consistent with the file.
* **Save (`Ctrl/Cmd+S`)**: the webview flushes its pending (debounced) edit synchronously on keydown
  and lets the event bubble to VS Code. In addition, the host handles
  `onWillSaveTextDocument` with `waitUntil(flush())`, so a save triggered from anywhere (menu,
  auto save, *Save All*) always includes the latest edits.
* **Diff views** (SCM, *Compare with…*, `vscode.diff`) open VS Code's native text diff editor for
  Markdown files (`TabInputTextDiff`), not the Live editor, so git diffs stay readable.

## Testing

* **Unit tests** (Vitest, `test/unit`): byte-identical golden round-trips of every fixture in LF and
  CRLF, targeted edits (one word → one line), forced regeneration checked for semantic equivalence,
  a Markdown fuzzer, the clipboard, the sync client, the text diff, syntax reveal and a real
  `git diff --numstat` in a temporary repository.
* **Integration tests** (`@vscode/test-cli`, `test/integration`): the custom editor in a real VS Code
  — opening never modifies a file, edits made in the webview (typing, bold, table cell, code) reach
  the `TextDocument` as one-line changes, undo restores the original bytes, external changes reach
  the webview, Mermaid and highlighting render under the webview CSP, syntax reveal, mode commands,
  save and diff behaviour.
* **Real repositories**: `npm run validate:repos -- <folder>... [--semantic] [--edits]` round-trips
  every Markdown file of the given folders (read-only; run it on copies) and reports byte identity,
  semantic equivalence after forced regeneration and one-line edits. On 9 788 real-world files
  (documentation repositories and an Obsidian vault): 9 788 byte-identical, 0 errors, semantic
  equivalence 9 788 / 9 788, one-line edits 9 324 / 9 324.

## Known limitations

* Syntax markers are display-only: they cannot be edited as text (type Markdown with input rules or
  use the toolbar instead). Markers of nested emphasis are shown in an approximate order.
* Constructs the editor does not model (HTML, footnotes, math, wikilinks, reference definitions,
  front matter) are edited as raw source, not visually. Inline math is displayed as text.
* CommonMark does not allow `_` / `__` delimiters inside a word: in a document that uses that style,
  emphasis applied to part of a word is written with a character reference next to the delimiter
  (for example `w&#x6F;__&#x72;d__`), which renders correctly but reads poorly in source.
* Adding or removing a table column regenerates the delimiter row of that table; editing a cell of
  an aligned (padded) table may re-pad the edited row.
* Pasting an image file (for example a screenshot) is not supported; images pasted as HTML keep their
  original URL, and no file is copied into the workspace.
* Split mode does not synchronise the scroll position of both editors.
* Mixed line endings in one file are normalised by VS Code itself when the file is opened.

## Development

```sh
npm install
npm run build          # bundles dist/extension.js and dist/webview/*
npm run watch          # incremental builds
npm run typecheck
npm run lint
npm test               # unit tests (Vitest)
npm run test:integration
npm run check          # typecheck + lint + unit tests + build
npm run package        # check + marklive-<version>.vsix
```

`node dev/serve.mjs` serves `dev/harness/index.html`, a browser harness that runs the webview with a
fake host (useful to debug the editor with browser dev tools).

`media/icon.png` is rendered from `media/logo.svg` by `scripts/generate-icon.ps1` (Windows, headless
Microsoft Edge).

Install the packaged extension with `code --install-extension marklive-0.1.0.vsix`.

### Integration tests

`npm run test:integration` runs the tests in a **freshly downloaded VS Code** (`version: 'stable'`,
cached in `.vscode-test/`) with an isolated profile: `--user-data-dir` and `--extensions-dir` point
into `.vscode-test/`. A root hook aborts the run if the extension's global storage is not inside
`.vscode-test/user-data/`.

Do **not** run the tests against a *portable* VS Code installation (for example the scoop package,
whose `data` folder sits next to `Code.exe`): portable mode ignores `--user-data-dir`, so the test
instance would share — and lock — the real user profile (webviews then fail with *Could not register
service worker*). `VSCODE_TEST_PATH` may point to another non-portable executable; portable ones are
rejected. Tests never write user settings: commands that change settings are exercised with the
workspace scope.

## License

MIT — see the `LICENSE` file.