import { createRoot } from 'react-dom/client';
import type { HostToWebviewMessage } from '../../shared/protocol';
import { LiveEditorController } from './controller';
import { App } from './ui/App';
import { getVsCodeApi } from './vscode';
import './styles.css';

const vscode = getVsCodeApi();
const controller = new LiveEditorController(vscode);
// Debug handle (developer tools / dev harness).
(window as unknown as { liveMarkdown: LiveEditorController }).liveMarkdown = controller;

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
  try {
    controller.handleMessage(message);
  } catch (error) {
    vscode.postMessage({
      type: 'error',
      message: `failed to process "${message.type}": ${error instanceof Error ? error.message : String(error)}`,
      detail: error instanceof Error ? error.stack : undefined,
    });
  }
});

createRoot(document.getElementById('root')!).render(<App controller={controller} vscode={vscode} />);

// Ctrl/Cmd held: links become clickable (styled as such).
const setModifier = (event: KeyboardEvent | MouseEvent) =>
  document.body.classList.toggle('lm-mod-down', event.ctrlKey || event.metaKey);
window.addEventListener('keydown', setModifier, true);
window.addEventListener('keyup', setModifier, true);
window.addEventListener('mousemove', setModifier, { capture: true, passive: true });
window.addEventListener('blur', () => document.body.classList.remove('lm-mod-down'));

vscode.postMessage({ type: 'ready' });
