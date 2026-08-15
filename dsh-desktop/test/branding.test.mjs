import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

test('desktop branding and package version are unified for v3.0.1', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.productName, 'DeepSeek Harness Desktop');
  assert.equal(pkg.version, '3.0.1');
  assert.match(read('preload.js'), /class="dch-title">DeepSeek Harness Desktop</);
  assert.match(read('main.js'), /const APP_NAME = 'DeepSeek Harness Desktop'/);
  assert.match(read('electron-builder.yml'), /productName: DeepSeek Harness Desktop/);
});

test('renamed desktop keeps upgrade compatibility with the EAC v2 data directory', () => {
  const main = read('main.js');
  assert.match(main, /legacyUserData.*Deepseek Harness EAC v2\.0/);
  assert.match(read('client-updater.js'), /Deepseek-Harness-EAC-/);
});
