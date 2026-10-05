// Configuration for `vscode-test` (@vscode/test-cli).
//
// The tests always run in an isolated VS Code downloaded into `.vscode-test/` (version "stable").
// Never point this at a portable installation (e.g. the scoop package): a portable VS Code ignores
// --user-data-dir / --extensions-dir and would share the real user profile with the test instance.
// `VSCODE_TEST_PATH` can override the executable explicitly, but portable installations are refused.
import { defineConfig } from '@vscode/test-cli';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = import.meta.dirname;
const workspace = join(root, '.vscode-test', 'workspace');
const userDataDir = join(root, '.vscode-test', 'user-data');
const extensionsDir = join(root, '.vscode-test', 'extensions');
for (const dir of [workspace, userDataDir, extensionsDir]) mkdirSync(dir, { recursive: true });

function explicitInstallation() {
  const exe = process.env.VSCODE_TEST_PATH;
  if (!exe) return undefined;
  if (existsSync(join(dirname(exe), 'data'))) {
    throw new Error(
      `VSCODE_TEST_PATH points to a portable VS Code (${exe}); it would share the real user profile. ` +
        'Unset VSCODE_TEST_PATH to use the isolated download.',
    );
  }
  return exe;
}

const fromPath = explicitInstallation();

export default defineConfig({
  label: 'integration',
  files: 'out/integration/suite/**/*.test.js',
  workspaceFolder: workspace,
  ...(fromPath ? { useInstallation: { fromPath } } : { version: 'stable' }),
  launchArgs: [
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
  ],
  mocha: { ui: 'tdd', timeout: 30000, color: true },
});
