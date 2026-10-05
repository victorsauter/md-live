/**
 * Mermaid rendering, loaded on demand (separate chunk) the first time a diagram is displayed.
 */
type MermaidApi = typeof import('mermaid').default;

let loading: Promise<MermaidApi> | null = null;
let initializedTheme: string | null = null;
let counter = 0;
let queue: Promise<unknown> = Promise.resolve();

export function isDarkTheme(): boolean {
  const cls = document.body.classList;
  return cls.contains('vscode-dark') || (cls.contains('vscode-high-contrast') && !cls.contains('vscode-high-contrast-light'));
}

function load(): Promise<MermaidApi> {
  loading ??= import('mermaid').then((m) => m.default);
  return loading;
}

function ensureInitialized(mermaid: MermaidApi): void {
  const theme = isDarkTheme() ? 'dark' : 'default';
  if (initializedTheme === theme) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme,
    fontFamily: 'var(--vscode-font-family)',
  });
  initializedTheme = theme;
}

export type MermaidResult = { svg: string } | { error: string };

/** Render `source` to SVG. Renders are serialized because Mermaid uses global state. */
export function renderMermaid(source: string): Promise<MermaidResult> {
  const run = async (): Promise<MermaidResult> => {
    const mermaid = await load();
    ensureInitialized(mermaid);
    const id = `lm-mermaid-${++counter}`;
    try {
      await mermaid.parse(source);
      const { svg } = await mermaid.render(id, source);
      return { svg };
    } catch (error) {
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
      const message = error instanceof Error ? error.message : String(error);
      return { error: message };
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

/** Forget the theme so that the next render picks up a theme change. */
export function resetMermaidTheme(): void {
  initializedTheme = null;
}
