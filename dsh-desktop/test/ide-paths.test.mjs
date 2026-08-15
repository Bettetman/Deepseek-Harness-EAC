import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { isPathInside, sameOriginMutation, validSegment } = await import(
  join(root, 'assets', 'plugins', 'dsh-file-changes', 'lib', 'ide-paths.js')
);

test('IDE 路径围栏拒绝前缀相同的兄弟目录和上级目录', () => {
  const workspace = resolve('/tmp', 'eac-workspace');
  assert.equal(isPathInside(workspace, workspace), true);
  assert.equal(isPathInside(workspace, join(workspace, 'src', 'index.js')), true);
  assert.equal(isPathInside(workspace, resolve('/tmp', 'eac-workspace-evil', 'x')), false);
  assert.equal(isPathInside(workspace, resolve(workspace, '..', 'secret')), false);
});

test('IDE 文件名只允许单个安全路径段', () => {
  assert.equal(validSegment('index.ts'), true);
  assert.equal(validSegment('../escape'), false);
  assert.equal(validSegment('a/b'), false);
  assert.equal(validSegment('a\\b'), false);
  assert.equal(validSegment(''), false);
  assert.equal(validSegment('bad:name.txt'), false);
  assert.equal(validSegment('name.'), false);
  assert.equal(validSegment('CON'), false);
  assert.equal(validSegment('LPT1.txt'), false);
  assert.equal(validSegment('normal file.txt'), true);
});

test('IDE 写请求要求 JSON，并拒绝跨源 Origin', () => {
  const request = (headers) => ({ headers });
  assert.equal(sameOriginMutation(request({ host: '127.0.0.1:3080', 'content-type': 'application/json' })), true);
  assert.equal(sameOriginMutation(request({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'application/json; charset=utf-8' })), true);
  assert.equal(sameOriginMutation(request({ host: '127.0.0.1:3080', origin: 'https://evil.example', 'content-type': 'application/json' })), false);
  assert.equal(sameOriginMutation(request({ host: '127.0.0.1:3080', origin: 'https://evil.example', 'content-type': 'text/plain' })), false);
});
