/**
 * Integration-test automation: lets the extension tests drive the real editor running inside the
 * VS Code webview. Only active when the host enables `testMode` (extension in test mode).
 */
import type { Editor } from '@tiptap/core';
import type { TestAction, TestProbe } from '../../shared/protocol';

declare global {
  interface Window {
    __lmErrors?: string[];
  }
}

function findText(editor: Editor, needle: string, occurrence = 0): { from: number; to: number } {
  let seen = 0;
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (!node.isText) return true;
    let index = node.text!.indexOf(needle);
    while (index >= 0) {
      if (seen++ === occurrence) {
        found = { from: pos + index, to: pos + index + needle.length };
        return false;
      }
      index = node.text!.indexOf(needle, index + 1);
    }
    return false;
  });
  if (!found) throw new Error(`text not found: ${needle}`);
  return found;
}

export function probe(editor: Editor, status: string): TestProbe {
  const blocks = [...document.querySelectorAll('.lm-code.lm-is-mermaid')];
  return {
    editable: editor.isEditable,
    status,
    textContent: editor.state.doc.textContent,
    mermaid: {
      blocks: blocks.length,
      svg: blocks.filter((b) => b.querySelector('.lm-mermaid-preview svg')).length,
      errors: blocks.filter((b) => b.querySelector('.lm-mermaid-error')).length,
    },
    highlightedTokens: document.querySelectorAll('.lm-code [class^="hljs-"]').length,
    syntax: [...editor.view.dom.querySelectorAll('.lm-syntax')].map((el) => el.textContent ?? ''),
    errors: [...(window.__lmErrors ?? [])],
  };
}

export function runTestAction(editor: Editor, action: TestAction, status: string): TestProbe {
  switch (action.kind) {
    case 'probe':
      break;
    case 'replaceText': {
      const { from, to } = findText(editor, action.needle, action.occurrence);
      editor.view.dispatch(editor.state.tr.insertText(action.text, from, to));
      break;
    }
    case 'toggleMark': {
      const { from, to } = findText(editor, action.needle, action.occurrence);
      editor.chain().setTextSelection({ from, to }).toggleMark(action.mark).run();
      break;
    }
    case 'undo':
      editor.commands.undo();
      break;
    case 'select': {
      const { from } = findText(editor, action.needle, action.occurrence);
      editor.view.focus();
      editor.commands.setTextSelection(from + (action.offset ?? 0));
      break;
    }
  }
  return probe(editor, status);
}
