import type { HostToWebviewMessage, WebviewToHostMessage } from '../../shared/protocol';

declare global {
  interface Window {
    vscodeApi: { postMessage(message: WebviewToHostMessage): void };
  }
}

// Minimal Phase 2 webview: shows the document text and echoes edits from a textarea.
const vscode = window.vscodeApi;
const root = document.getElementById('root')!;
const area = document.createElement('textarea');
area.style.width = '100%';
area.style.height = '90vh';
root.appendChild(area);
let version = 0;
let editId = 0;
window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const msg = event.data;
  if (msg.type === 'init' || msg.type === 'update') {
    area.value = msg.text;
    version = msg.version;
  } else if (msg.type === 'ack') version = msg.version;
  else if (msg.type === 'flush') vscode.postMessage({ type: 'flushed', requestId: msg.requestId });
});
area.addEventListener('input', () => {
  vscode.postMessage({ type: 'edit', text: area.value, baseVersion: version, editId: ++editId });
});
vscode.postMessage({ type: 'ready' });
