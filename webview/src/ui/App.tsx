import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import type { SyncStatus } from '../../../shared/sync/SyncClient';
import type { LiveEditorController } from '../controller';
import { isTaskItem, toggleTask } from '../editor/behaviors';
import { LANGUAGE_SUGGESTIONS } from '../editor/highlight';
import { insertBlockAfterText, insertTable, setColumnAlign, tableContext, type Align } from '../editor/table';
import type { VsCodeApi } from '../vscode';

interface AppProps {
  controller: LiveEditorController;
  vscode: VsCodeApi;
}

type Dialog = { kind: 'link'; href: string; text: string; hasSelection: boolean } | { kind: 'image' } | null;

export function App({ controller, vscode }: AppProps) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<SyncStatus>(controller.client.currentStatus);
  const [loaded, setLoaded] = useState(controller.client.loaded);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const editor = controller.editor;

  useLayoutEffect(() => {
    host.current?.appendChild(controller.element);
  }, [controller]);

  useEffect(
    () =>
      controller.subscribe((event) => {
        if (event.type === 'status') setStatus(event.status);
        else if (event.type === 'loaded') setLoaded(true);
        else if (event.type === 'requestLink') setDialog(linkDialogState(editor));
      }),
    [controller, editor],
  );

  // Keys handled by the editor must not reach VS Code (Ctrl+B, Ctrl+K, Ctrl+Z...), except save.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
        controller.client.send();
        return;
      }
      if (event.defaultPrevented) event.stopPropagation();
    };
    element.addEventListener('keydown', onKeyDown);
    return () => element.removeEventListener('keydown', onKeyDown);
  }, [controller]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const cell = target?.closest('td, th');
      if (!cell || !editor.view.dom.contains(cell)) return;
      const anchor = window.getSelection()?.anchorNode ?? null;
      const inside = cell.classList.contains('selectedCell') || (anchor !== null && cell.contains(anchor));
      if (!inside || !tableContext(editor.state)) {
        const coords = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
        const pos = coords && cell.contains(editor.view.domAtPos(coords.pos).node) ? coords.pos : editor.view.posAtDOM(cell, 0);
        editor.commands.setTextSelection(pos);
      }
      if (!tableContext(editor.state)) return;
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY });
    };
    element.addEventListener('contextmenu', onContextMenu);
    return () => element.removeEventListener('contextmenu', onContextMenu);
  }, [editor]);

  const switchMode = (mode: 'source' | 'split') => {
    controller.client.send();
    vscode.postMessage({ type: 'switchMode', mode });
  };

  return (
    <div className="lm-app">
      <Toolbar
        editor={editor}
        onSwitchMode={switchMode}
        onLink={() => setDialog(linkDialogState(editor))}
        onImage={() => setDialog({ kind: 'image' })}
      />
      <main className="lm-scroll">
        {!loaded && <div className="lm-loading">Loading…</div>}
        <div ref={host} className="lm-document" />
      </main>
      <StatusBar status={status} />
      {dialog?.kind === 'link' && <LinkDialog editor={editor} state={dialog} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'image' && <ImageDialog editor={editor} onClose={() => setDialog(null)} />}
      {menu && <TableMenu editor={editor} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      <datalist id="lm-languages">
        {LANGUAGE_SUGGESTIONS.map((language) => (
          <option key={language} value={language} />
        ))}
      </datalist>
    </div>
  );
}

// ------------------------------------------------------------------ toolbar

function Button(props: {
  label: string;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`lm-btn${props.active ? ' lm-btn-active' : ''}${props.className ? ` ${props.className}` : ''}`}
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active}
      disabled={props.disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function Group({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="lm-group" role="group" aria-label={label}>
      {children}
    </div>
  );
}

const mod = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+';

function Toolbar(props: {
  editor: Editor;
  onSwitchMode: (mode: 'source' | 'split') => void;
  onLink: () => void;
  onImage: () => void;
}) {
  const { editor } = props;
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      const heading = [1, 2, 3, 4, 5, 6].find((level) => e.isActive('heading', { level })) ?? 0;
      const table = tableContext(e.state);
      return {
        editable: e.isEditable,
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        strike: e.isActive('strike'),
        code: e.isActive('code'),
        link: e.isActive('link'),
        heading,
        inCode: e.isActive('codeBlock'),
        bulletList: e.isActive('bulletList') && !isTaskItem(e.state),
        orderedList: e.isActive('orderedList'),
        task: isTaskItem(e.state),
        blockquote: e.isActive('blockquote'),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
        table: table ? { header: table.rowIndex === 0, align: table.align, rows: table.rows } : null,
      };
    },
  });
  if (!state) return null;
  const chain = () => editor.chain().focus();
  const disabled = !state.editable;

  return (
    <header className="lm-toolbar" role="toolbar" aria-label="Markdown formatting">
      <Group label="Mode">
        <Button label="Live" title="Live editor (current)" active onClick={() => editor.commands.focus()} />
        <Button label="Source" title="Open the Markdown source (Ctrl+Shift+M)" onClick={() => props.onSwitchMode('source')} />
        <Button label="Split" title="Source and Live side by side" onClick={() => props.onSwitchMode('split')} />
      </Group>
      <Group label="History">
        <Button label="↶" title={`Undo (${mod}Z)`} disabled={disabled || !state.canUndo} onClick={() => chain().undo().run()} />
        <Button label="↷" title={`Redo (${mod}Y)`} disabled={disabled || !state.canRedo} onClick={() => chain().redo().run()} />
      </Group>
      <Group label="Block">
        <select
          className="lm-select"
          title="Block type"
          aria-label="Block type"
          disabled={disabled || state.inCode}
          value={String(state.heading)}
          onChange={(event) => {
            const level = Number(event.target.value);
            if (level === 0) chain().setParagraph().run();
            else chain().setHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 }).run();
          }}
        >
          <option value="0">Paragraph</option>
          {[1, 2, 3, 4, 5, 6].map((level) => (
            <option key={level} value={level}>
              Heading {level}
            </option>
          ))}
        </select>
      </Group>
      <Group label="Inline">
        <Button label="B" className="lm-b" title={`Bold (${mod}B)`} active={state.bold} disabled={disabled} onClick={() => chain().toggleBold().run()} />
        <Button label="I" className="lm-i" title={`Italic (${mod}I)`} active={state.italic} disabled={disabled} onClick={() => chain().toggleItalic().run()} />
        <Button label="S" className="lm-s" title={`Strikethrough (${mod}Shift+S)`} active={state.strike} disabled={disabled} onClick={() => chain().toggleStrike().run()} />
        <Button label="</>" title={`Inline code (${mod}E)`} active={state.code} disabled={disabled} onClick={() => chain().toggleCode().run()} />
        <Button label="Link" title={`Link (${mod}K)`} active={state.link} disabled={disabled} onClick={props.onLink} />
      </Group>
      <Group label="Lists">
        <Button label="•" title={`Bullet list (${mod}Shift+8)`} active={state.bulletList} disabled={disabled} onClick={() => chain().toggleBulletList().run()} />
        <Button label="1." title={`Numbered list (${mod}Shift+7)`} active={state.orderedList} disabled={disabled} onClick={() => chain().toggleOrderedList().run()} />
        <Button label="☑" title={`Task list (${mod}Shift+9)`} active={state.task} disabled={disabled} onClick={() => toggleTask(editor)} />
        <Button label="❝" title={`Quote (${mod}Shift+B)`} active={state.blockquote} disabled={disabled} onClick={() => chain().toggleBlockquote().run()} />
      </Group>
      <Group label="Insert">
        <Button label="{ }" title={`Code block (${mod}Alt+C)`} active={state.inCode} disabled={disabled} onClick={() => chain().toggleCodeBlock().run()} />
        <Button label="Table" title="Insert table" disabled={disabled || state.table !== null} onClick={() => insertTable(editor)} />
        <Button label="Image" title="Insert image" disabled={disabled} onClick={props.onImage} />
        <Button label="―" title="Horizontal rule" disabled={disabled} onClick={() => insertBlockAfterText(editor, (c) => c.setHorizontalRule())} />
      </Group>
      {state.table && (
        <Group label="Table">
          <TableActions editor={editor} header={state.table.header} align={state.table.align} rows={state.table.rows} />
        </Group>
      )}
    </header>
  );
}

function TableActions({ editor, header, align, rows }: { editor: Editor; header: boolean; align: Align; rows: number }) {
  const chain = () => editor.chain().focus();
  return (
    <>
      <Button label="+Row↑" title="Insert row above" disabled={header} onClick={() => chain().addRowBefore().run()} />
      <Button label="+Row↓" title="Insert row below" onClick={() => chain().addRowAfter().run()} />
      <Button label="+Col←" title="Insert column left" onClick={() => chain().addColumnBefore().run()} />
      <Button label="+Col→" title="Insert column right" onClick={() => chain().addColumnAfter().run()} />
      <Button label="−Row" title="Delete row" disabled={header && rows <= 1} onClick={() => chain().deleteRow().run()} />
      <Button label="−Col" title="Delete column" onClick={() => chain().deleteColumn().run()} />
      <Button label="⇤" title="Align column left" active={align === 'left'} onClick={() => setColumnAlign(editor, align === 'left' ? null : 'left')} />
      <Button label="⇔" title="Center column" active={align === 'center'} onClick={() => setColumnAlign(editor, align === 'center' ? null : 'center')} />
      <Button label="⇥" title="Align column right" active={align === 'right'} onClick={() => setColumnAlign(editor, align === 'right' ? null : 'right')} />
      <Button label="✕" title="Delete table" onClick={() => chain().deleteTable().run()} />
    </>
  );
}

// ------------------------------------------------------------------ table context menu

function TableMenu({ editor, x, y, onClose }: { editor: Editor; x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const context = tableContext(editor.state);
  useEffect(() => {
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event.type === 'mousedown' && ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', close, true);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', close, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);
  if (!context) return null;
  const header = context.rowIndex === 0;
  const run = (action: () => unknown) => () => {
    action();
    onClose();
  };
  const chain = () => editor.chain().focus();
  const items: Array<{ label: string; action: () => unknown; disabled?: boolean } | 'separator'> = [
    { label: 'Insert row above', action: () => chain().addRowBefore().run(), disabled: header },
    { label: 'Insert row below', action: () => chain().addRowAfter().run() },
    { label: 'Insert column left', action: () => chain().addColumnBefore().run() },
    { label: 'Insert column right', action: () => chain().addColumnAfter().run() },
    'separator',
    { label: 'Delete row', action: () => chain().deleteRow().run(), disabled: header && context.rows <= 1 },
    { label: 'Delete column', action: () => chain().deleteColumn().run() },
    'separator',
    { label: 'Align left', action: () => setColumnAlign(editor, 'left') },
    { label: 'Align center', action: () => setColumnAlign(editor, 'center') },
    { label: 'Align right', action: () => setColumnAlign(editor, 'right') },
    { label: 'Default alignment', action: () => setColumnAlign(editor, null) },
    'separator',
    { label: 'Delete table', action: () => chain().deleteTable().run() },
  ];
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - 330);
  return (
    <div ref={ref} className="lm-menu" role="menu" style={{ left, top }}>
      {items.map((item, index) =>
        item === 'separator' ? (
          <div key={index} className="lm-menu-separator" role="separator" />
        ) : (
          <button
            key={index}
            type="button"
            role="menuitem"
            className="lm-menu-item"
            disabled={item.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={run(item.action)}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

// ------------------------------------------------------------------ dialogs

function linkDialogState(editor: Editor): Dialog {
  const { state } = editor;
  const { from, to, empty } = state.selection;
  const href = (editor.getAttributes('link').href as string | undefined) ?? '';
  return { kind: 'link', href, text: empty ? '' : state.doc.textBetween(from, to, ' '), hasSelection: !empty };
}

function Modal({ title, children, onClose, onSubmit }: { title: string; children: ReactNode; onClose: () => void; onSubmit: () => void }) {
  return (
    <div
      className="lm-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="lm-modal"
        role="dialog"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <h2>{title}</h2>
        {children}
      </form>
    </div>
  );
}

function LinkDialog({ editor, state, onClose }: { editor: Editor; state: Extract<Dialog, { kind: 'link' }>; onClose: () => void }) {
  const [href, setHref] = useState(state.href);
  const [text, setText] = useState(state.text);
  const close = () => {
    onClose();
    editor.commands.focus();
  };
  const submit = () => {
    const url = href.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      onClose();
      return;
    }
    if (editor.isActive('link')) {
      editor.chain().focus().extendMarkRange('link').updateAttributes('link', { href: url }).run();
    } else if (state.hasSelection) {
      editor.chain().focus().setLink({ href: url }).run();
    } else {
      const label = text.trim() || url;
      const { from } = editor.state.selection;
      editor
        .chain()
        .focus()
        .insertContent({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href: url } }] })
        .setTextSelection(from + label.length)
        .unsetMark('link')
        .run();
    }
    onClose();
  };
  return (
    <Modal title={state.href ? 'Edit link' : 'Insert link'} onClose={close} onSubmit={submit}>
      {!state.hasSelection && !state.href && (
        <label>
          Text
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Link text" />
        </label>
      )}
      <label>
        URL
        <input autoFocus value={href} onChange={(e) => setHref(e.target.value)} placeholder="https://… or ./file.md#heading" />
      </label>
      <div className="lm-modal-actions">
        {state.href && (
          <button
            type="button"
            onClick={() => {
              editor.chain().focus().extendMarkRange('link').unsetLink().run();
              onClose();
            }}
          >
            Remove link
          </button>
        )}
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="lm-primary">
          OK
        </button>
      </div>
    </Modal>
  );
}

function ImageDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [src, setSrc] = useState('');
  const [alt, setAlt] = useState('');
  const close = () => {
    onClose();
    editor.commands.focus();
  };
  const submit = () => {
    if (src.trim()) {
      editor.chain().focus().insertContent({ type: 'image', attrs: { src: src.trim(), alt: alt.trim() } }).run();
    }
    onClose();
  };
  return (
    <Modal title="Insert image" onClose={close} onSubmit={submit}>
      <label>
        Source
        <input autoFocus value={src} onChange={(e) => setSrc(e.target.value)} placeholder="./images/diagram.png or https://…" />
      </label>
      <label>
        Alternative text
        <input value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="Description" />
      </label>
      <div className="lm-modal-actions">
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="lm-primary">
          Insert
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ status

function StatusBar({ status }: { status: SyncStatus }) {
  if (status.kind === 'error') {
    return (
      <footer className="lm-status lm-status-error" role="status" title={status.message}>
        ⚠ Last change not written to the file (it would alter other Markdown): {status.message}
      </footer>
    );
  }
  return (
    <footer className="lm-status" role="status">
      {status.kind === 'pending' ? 'Syncing…' : 'Synced'}
    </footer>
  );
}
