# Live Markdown Editor

A Typora/Obsidian-style **live** Markdown editor for VS Code. Markdown files open in a rich editing
view where formatting is rendered as you type, while the file on disk stays plain Markdown that
remains readable, diff-friendly and **byte-for-byte identical** wherever you did not edit.

> Status: in development.

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

* **Live mode** is a `CustomTextEditorProvider` registered with priority `default` for `*.md` and
  `*.markdown`. The provider never owns the document: VS Code's `TextDocument` stays the source of
  truth, so dirty state, save, hot exit, auto save, git and other extensions keep working.
* **Source mode** is VS Code's native text editor (`vscode.openWith(uri, 'default')`).
  **Split mode** shows the native editor and the Live editor side by side (`ViewColumn.Beside`).
  Switching modes replaces the tab in place (like *Reopen Editor With…*), so unsaved changes are
  kept without a "Save changes?" prompt.
* **Lossless writing.** The webview keeps the original Markdown and a source map from document
  nodes to byte ranges. On every change only the modified blocks are re-serialized (with the
  document's detected style); untouched blocks reuse the original bytes. The host then applies a
  minimal text diff to the `TextDocument`. Line endings (LF/CRLF), the final newline and constructs
  the editor does not model (HTML, front matter, footnotes, reference definitions, `[[wikilinks]]`,
  math, …) are preserved verbatim. If serialization or its verification fails, nothing is written.

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

## Development

```sh
npm install
npm run build          # bundles dist/extension.js and dist/webview/*
npm run watch          # incremental builds
npm run typecheck
npm run lint
npm test               # unit tests (Vitest)
npm run test:integration
```

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
