import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { configLinesFor, ensureIdeLayoutPatch, ensureInsertRowDisabled, healSoulMdPatchRow, removeBundledRowDuplicates } = require(join(root, 'patch-row-heal.js'));

// v2.0.0 实际写进用户 profile 的坏行：只有 id + name，没有 config。
const BROKEN_PATCH = [
  '# dsh web profile patch（由 DSH Desktop 维护）',
  '- insert:',
  '    - id: soul-md',
  "      name: 'dsh-soul-md'",
  '- insert:',
  '    - id: tdai-memory',
  "      name: 'dsh-tdai-memory'",
  '',
].join('\n');

test('healSoulMdPatchRow 补上缺失的 config.path（v2.0.0 存量坏行）', () => {
  const { patch, healed } = healSoulMdPatchRow(BROKEN_PATCH);
  assert.deepEqual(healed, ['soul-md']);
  assert.match(patch, /- id: soul-md\n\s*name: 'dsh-soul-md'\n\s*config:\n\s*path: "soul\.md"\n/);
  // 其他行不受影响
  assert.match(patch, /- id: tdai-memory\n\s*name: 'dsh-tdai-memory'\n/);
  assert.equal(patch.match(/- id: soul-md/g).length, 1, '不应重复插入行');
});

test('healSoulMdPatchRow 幂等：已有 config 的行不再改动', () => {
  const once = healSoulMdPatchRow(BROKEN_PATCH).patch;
  const twice = healSoulMdPatchRow(once);
  assert.deepEqual(twice.healed, []);
  assert.equal(twice.patch, once);
});

test('healSoulMdPatchRow 对无 soul-md 行 / 空内容安全', () => {
  assert.deepEqual(healSoulMdPatchRow('- insert:\n    - id: tool-vision\n').healed, []);
  assert.deepEqual(healSoulMdPatchRow('').healed, []);
});

test('configLinesFor 生成合法 patch YAML', () => {
  assert.equal(configLinesFor({ path: 'soul.md' }), '      config:\n        path: "soul.md"\n');
});

test('ensureIdeLayoutPatch 关闭官方布局并幂等挂载 IDE 布局', () => {
  const once = ensureIdeLayoutPatch(BROKEN_PATCH);
  assert.match(once, /- id: ui-layout\n  disabled: true/);
  assert.match(once, /- id: ide-layout\n      name: '@anoslide\/dsh-client-vscode-layout'/);
  assert.equal(ensureIdeLayoutPatch(once), once);
  assert.equal(once.match(/id: ide-layout/g).length, 1);
});

test('ensureIdeLayoutPatch 清理旧式布局行，避免 duplicate ide-layout', () => {
  const legacy = [
    '- id: ui-layout',
    '  disabled: true',
    '- insert:',
    '    - id: ide-layout',
    "      name: '@anoslide/dsh-client-vscode-layout'",
    '- insert:',
    '    - id: terminal',
    "      name: '@deepseek-ai/dsh-terminal'",
    '',
  ].join('\n');
  const out = ensureIdeLayoutPatch(legacy);
  assert.equal(out.match(/id: ui-layout/g).length, 1);
  assert.equal(out.match(/id: ide-layout/g).length, 1);
  assert.match(out, /- id: terminal/);
  assert.equal(ensureIdeLayoutPatch(out), out);
});

test('ensureIdeLayoutPatch 清理共享 insert 中的旧布局时保留其他插件', () => {
  const legacy = [
    '- insert:',
    '    - id: ide-layout',
    "      name: '@anoslide/dsh-client-vscode-layout'",
    '    - id: terminal',
    "      name: '@deepseek-ai/dsh-terminal'",
    '      config:',
    '        shell: powershell',
    '',
  ].join('\n');
  const out = ensureIdeLayoutPatch(legacy);
  assert.equal(out.match(/id: ide-layout/g).length, 1);
  assert.match(out, /- id: terminal[\s\S]*shell: powershell/, '同一 insert 下的 sibling 必须完整保留');
  assert.equal(ensureIdeLayoutPatch(out), out);
});

test('ensureInsertRowDisabled 只停用目标行并保持配置幂等', () => {
  const patch = [
    '- insert:',
    '    - id: tdai-memory',
    "      name: 'dsh-tdai-memory'",
    '      config:',
    '        database: local',
    '- insert:',
    '    - id: terminal',
    "      name: '@deepseek-ai/dsh-terminal'",
    '',
  ].join('\n');
  const once = ensureInsertRowDisabled(patch, 'tdai-memory');
  assert.equal(once.changed, true);
  assert.match(once.patch, /- id: tdai-memory\n\s+disabled: true\n\s+name: 'dsh-tdai-memory'[\s\S]*database: local/);
  assert.match(once.patch, /- id: terminal\n\s+name: '@deepseek-ai\/dsh-terminal'/);
  const twice = ensureInsertRowDisabled(once.patch, 'tdai-memory');
  assert.equal(twice.changed, false);
  assert.equal(twice.patch, once.patch);
});

test('ensureInsertRowDisabled 把显式 false 修成 true', () => {
  const patch = "- insert:\n    - id: tdai-memory\n      name: 'dsh-tdai-memory'\n      disabled: false\n";
  const out = ensureInsertRowDisabled(patch, 'tdai-memory');
  assert.equal(out.changed, true);
  assert.match(out.patch, /disabled: true/);
  assert.doesNotMatch(out.patch, /disabled: false/);
});

// 根因防回归：schema 的 path 必须有默认值（文件缺失 → fallback 空 → 不注册
// section，官方提示词原样使用），绝不能再变回 required 无默认。
test('dsh-soul-md schema: path 带默认值，不再是 required', () => {
  const src = readFileSync(join(root, 'assets', 'plugins', 'dsh-soul-md', 'index.js'), 'utf8');
  assert.match(src, /path:\s*z\.string\(\)\.default\(/, 'path 必须带 .default()');
  assert.doesNotMatch(src, /path:\s*z\.string\(\)\.required\(\)/, 'path 不能是 required 无默认');
});

// main.js 侧双保险：新增行必须显式写 config，且启动时 heal 存量坏行。
test('main.js: soul-md 行带 config + 启动时执行存量 heal', () => {
  const src = readFileSync(join(root, 'main.js'), 'utf8');
  assert.match(src, /id:\s*'soul-md',[^\n]*config:\s*\{\s*path:\s*'soul\.md'\s*\}/);
  assert.match(src, /healSoulMdPatchRow\(patch\)/);
  assert.match(src, /block \+= configLinesFor\(p\.config\)/);
});

// 市场安装（dsh plugin add 登记 bundles）与 overlay 写行双挂载 →
// "duplicate loader entry id" 拖垮插件树。overlay 重复行必须被移除。
test('removeBundledRowDuplicates: 删 bundle 已登记的 overlay 行', () => {
  const patch = [
    '- insert:',
    '    - id: soul-md',
    "      name: 'dsh-soul-md'",
    '      config:',
    '        path: "soul.md"',
    '- insert:',
    '    - id: mobile-fix',
    "      name: 'dsh-web-mobile-fix'",
    '- insert:',
    '    - id: terminal',
    "      name: '@deepseek-ai/dsh-terminal'",
    '',
  ].join('\n');
  const rowIds = { 'soul-md': 'dsh-soul-md', 'mobile-fix': 'dsh-web-mobile-fix', terminal: '@deepseek-ai/dsh-terminal' };
  const { patch: out, removed } = removeBundledRowDuplicates(patch, rowIds, ['dsh-web-mobile-fix']);
  assert.deepEqual(removed, ['mobile-fix']);
  assert.doesNotMatch(out, /mobile-fix/);
  assert.match(out, /- id: soul-md[\s\S]*path: "soul\.md"/, '相邻块的 config 完整保留');
  assert.match(out, /- id: terminal/);
});

test('removeBundledRowDuplicates: 无 bundle 登记时不动任何行', () => {
  const rowIds = { 'mobile-fix': 'dsh-web-mobile-fix' };
  const { patch: out, removed } = removeBundledRowDuplicates(BROKEN_PATCH, rowIds, []);
  assert.deepEqual(removed, []);
  assert.equal(out, BROKEN_PATCH);
});

test('removeBundledRowDuplicates: 非 uninstall 目标插件（tts 等）不受影响', () => {
  const patch = '- insert:\n    - id: tts\n      name: \'@dsh-external/dsh-plugin-tts\'\n';
  const rowIds = { 'mobile-fix': 'dsh-web-mobile-fix' };
  const { removed } = removeBundledRowDuplicates(patch, rowIds, ['@dsh-external/dsh-plugin-tts']);
  assert.deepEqual(removed, [], 'rowIds 不含 tts，即使 bundle 里有也不动');
});
