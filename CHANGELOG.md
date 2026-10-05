# Changelog

## 0.1.0

First release.

* **Live mode**: a custom text editor (default for `*.md` / `*.markdown`) that renders Markdown as
  formatted content and edits it in place — headings, emphasis, strikethrough, inline code, links,
  images, blockquotes, nested bullet / numbered / task lists, horizontal rules, GFM tables, fenced
  code blocks with syntax highlighting (lowlight) and Mermaid previews loaded on demand.
* **Source and Split modes**: the native VS Code text editor, alone or side by side with Live mode;
  commands, editor title buttons and a status bar item switch between modes.
* **Lossless round-trip**: unchanged blocks keep their original bytes; edited blocks are regenerated
  with the document's detected style and written as minimal `WorkspaceEdit`s, so changing a word
  changes one line in `git diff`. EOL (LF / CRLF), final newline, byte order mark and unsupported
  constructs (HTML, front matter, footnotes, reference definitions, wikilinks, math) are preserved.
  Nothing is written if serialisation fails.
* **Native document integration**: undo / redo, save, dirty state, hot exit and SCM diff are those of
  VS Code's `TextDocument`; external changes are merged into the open editor.
* **Syntax reveal**: Markdown markers of the element under the cursor are shown around it
  (Obsidian-style), configurable with `liveMarkdown.syntaxReveal`.
* Toolbar, Markdown input rules, keyboard shortcuts, link / image dialogs, table editing commands,
  Markdown-aware copy and paste, theme-aware styling (light, dark, high contrast).
* Unit tests (golden byte-identical, targeted edits, semantic equivalence, fuzzing), integration tests
  in a real VS Code, and a read-only validation script for real repositories.
