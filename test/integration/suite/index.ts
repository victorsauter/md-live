// Entry point used by the "Extension Tests" launch configuration (vscode-test uses .vscode-test.mjs).
import * as fs from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30000 });
  const dir = __dirname;
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.test.js')) mocha.addFile(path.join(dir, file));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} tests failed`)) : resolve()));
  });
}
