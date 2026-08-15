import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('balance waits for the composer dock declaration before registering', () => {
  const src = readFileSync(join(root, 'assets', 'plugins', 'dsh-balance', 'lib', 'client.js'), 'utf8');
  assert.match(
    src,
    /slots\.inject\("conversation\.composer\.dock"[\s\S]*slots\.register\(\{[\s\S]*name:\s*"conversation\.composer\.dock"/,
    'nested slot registrations must not depend on client plugin load order',
  );
});

test('IDE layout keeps blank-session cwd and workspace roots on every file request', () => {
  const src = readFileSync(join(root, 'assets', 'plugins', 'dsh-vscode-layout', 'lib', 'client.js'), 'utf8');
  assert.match(src, /return row !== void 0 \? row\.cwd : void 0/);
  assert.doesNotMatch(src, /row\.blank !== true \? row\.cwd/);
  for (const endpoint of ['list', 'read', 'highlight', 'git', 'search']) {
    const marker = `/vscode-files/${endpoint}?root=`;
    assert.ok(src.includes(marker), `${endpoint} request must identify its registered workspace root`);
  }
  assert.match(src, /body:\s*JSON\.stringify\(\{ root, path \}\)/, 'delete must send the workspace root');
  assert.match(src, /expectedRevision:\s*edit\.revision/, 'save must carry its optimistic-concurrency revision');
});

test('host file routes support recoverable deletion on all desktop platforms', () => {
  const src = readFileSync(join(root, 'assets', 'plugins', 'dsh-file-changes', 'lib', 'index.js'), 'utf8');
  assert.match(src, /process\.platform === "win32"/);
  assert.match(src, /process\.platform === "darwin"/);
  assert.match(src, /"gio", \["trash", "--", target\]/);
  assert.match(src, /sameOriginMutation\(req\)/, 'mutating routes must enforce same-origin JSON requests');
});

test('desktop sync includes the IDE package and guards Windows-only memory natives', () => {
  const src = readFileSync(join(root, 'main.js'), 'utf8');
  assert.match(src, /name:\s*'@anoslide\/dsh-client-vscode-layout'[\s\S]*profileRow:\s*false/);
  assert.match(src, /id:\s*'tdai-memory'[\s\S]*disabled:\s*!IS_WIN/);
  assert.match(src, /ensureInsertRowDisabled\(patch, 'tdai-memory'\)/);
});
