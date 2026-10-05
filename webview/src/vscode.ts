import type { WebviewToHostMessage } from '../../shared/protocol';

export interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
}

declare global {
  interface Window {
    vscodeApi: VsCodeApi;
  }
}

/** The API acquired by the inline bootstrap script of the webview HTML. */
export function getVsCodeApi(): VsCodeApi {
  return window.vscodeApi;
}
