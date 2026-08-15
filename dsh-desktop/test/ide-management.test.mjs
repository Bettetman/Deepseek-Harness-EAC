import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addMcpEntry,
  deleteMcpEntry,
  listMcpEntries,
  normalizeMcpInput,
  toggleMcpEntry,
} from '../assets/plugins/dsh-file-changes/lib/ide-management.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const EXISTING = [
  '- insert:',
  '    - id: mcp-files',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        transport: stdio',
  '        serverName: "files"',
  '        command: "npx"',
  '        args: ["-y", "server-files"]',
  '        env: {"TOKEN":"secret"}',
  '- insert:',
  '    - id: terminal',
  "      name: '@deepseek-ai/dsh-terminal'",
  '',
].join('\n');

test('MCP manager lists current cordis.patch rows without returning secret values', () => {
  const entries = listMcpEntries(EXISTING);
  assert.deepEqual(entries, [{
    id: 'mcp-files',
    serverName: 'files',
    transport: 'stdio',
    command: 'npx',
    url: '',
    enabled: true,
    hasEnv: true,
  }]);
  assert.doesNotMatch(JSON.stringify(entries), /secret/);
});

test('MCP manager adds, toggles and removes only dsh-mcp-client rows', () => {
  const added = addMcpEntry(EXISTING, {
    serverName: 'docs',
    transport: 'streamable-http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer private' },
  });
  assert.equal(listMcpEntries(added.patch).length, 2);
  assert.match(added.patch, /headers: \{"Authorization":"Bearer private"\}/);
  const toggled = toggleMcpEntry(added.patch, 'mcp-docs');
  assert.equal(toggled.enabled, false);
  assert.equal(listMcpEntries(toggled.patch).find((entry) => entry.id === 'mcp-docs').enabled, false);
  const removed = deleteMcpEntry(toggled.patch, 'mcp-docs');
  assert.equal(listMcpEntries(removed).length, 1);
  assert.match(removed, /id: terminal/, 'unrelated plugin rows must survive MCP deletion');
});

test('MCP manager rejects duplicate ids and unsafe configuration shapes', () => {
  assert.throws(() => addMcpEntry(EXISTING, { serverName: 'files', transport: 'stdio', command: 'node' }), /already exists/);
  assert.throws(() => normalizeMcpInput({ serverName: '../bad', command: 'node' }), /serverName/);
  assert.throws(() => normalizeMcpInput({ serverName: 'remote', transport: 'streamable-http', url: 'file:///tmp/x' }), /http/);
  assert.throws(() => normalizeMcpInput({ serverName: 'local', transport: 'stdio', command: 'node\ncalc' }), /command/);
});

test('settings client registers Skill/MCP sections and sends opaque Skill ids', () => {
  const src = readFileSync(join(root, 'assets', 'plugins', 'dsh-vscode-layout', 'lib', 'client.js'), 'utf8');
  assert.match(src, /id: "skills"[\s\S]*SkillSection/);
  assert.match(src, /id: "mcp"[\s\S]*MCPSection/);
  assert.match(src, /JSON\.stringify\(\{ id \}\)/);
  assert.doesNotMatch(src, /JSON\.stringify\(\{ path \}\)/);
  assert.match(src, /window\.dshDesktop\?\.restartService/);
});

test('host manager fences Skills and atomically updates the active web profile', () => {
  const src = readFileSync(join(root, 'assets', 'plugins', 'dsh-file-changes', 'lib', 'index.js'), 'utf8');
  assert.match(src, /join\(dshHomeRoot\(\), "skills"\)/);
  assert.match(src, /symbolic-link Skills cannot be managed here/);
  assert.match(src, /withFileLock\(file/);
  assert.match(src, /writeFileAtomic\(file, result\.patch, \{ mode: 0o600/);
  assert.match(src, /sameOriginMutation\(req\)/);
});
