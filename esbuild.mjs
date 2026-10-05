// Builds the two bundles of the extension:
//  - dist/extension.js      : extension host (Node, CommonJS, `vscode` external)
//  - dist/webview/main.js   : webview (browser, ESM with code splitting so Mermaid is loaded on demand)
import { rm } from 'node:fs/promises';
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').Plugin} */
const problemMatcher = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => console.log(`[${build.initialOptions.outdir ?? build.initialOptions.outfile}] build started`));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) console.error(`    ${location.file}:${location.line}:${location.column}:`);
      }
      console.log(`[${build.initialOptions.outdir ?? build.initialOptions.outfile}] build finished`);
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'warning',
  plugins: [problemMatcher],
};

/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: ['webview/src/main.tsx'],
  outdir: 'dist/webview',
  bundle: true,
  format: 'esm',
  splitting: true,
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: !production,
  minify: production,
  chunkNames: 'chunks/[name]-[hash]',
  loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' },
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  logLevel: 'warning',
  plugins: [problemMatcher],
};

if (watch) {
  const contexts = await Promise.all([esbuild.context(extensionOptions), esbuild.context(webviewOptions)]);
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  // Start from an empty folder so stale chunks (and source maps of development builds) are never packaged.
  await rm('dist', { recursive: true, force: true });
  await Promise.all([esbuild.build(extensionOptions), esbuild.build(webviewOptions)]);
}
