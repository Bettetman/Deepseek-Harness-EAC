import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  fetchOnlineCatalog,
  listMcpMarket,
  prepareMcpMarketInstall,
  saveMcpMarketConfig,
} from '../assets/plugins/dsh-file-changes/lib/mcp-market.js';
import { addMcpEntry, listMcpEntries } from '../assets/plugins/dsh-file-changes/lib/ide-management.js';

function response(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

const OFFICIAL_NPM = {
  server: {
    name: 'io.example/files',
    title: 'Example Files',
    description: 'A registry MCP server',
    version: '1.2.3',
    packages: [{
      registryType: 'npm',
      identifier: '@example/files-mcp',
      version: '1.2.3',
      runtimeHint: 'npx',
      transport: { type: 'stdio' },
      runtimeArguments: [{ type: 'positional', value: '-y' }],
      packageArguments: [{ type: 'named', name: 'root', isRequired: true }],
      environmentVariables: [{ name: 'EXAMPLE_TOKEN', isRequired: true, isSecret: true }],
    }],
  },
  _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
};

test('official Registry response becomes a pinned safe npx template', async () => {
  let requested = '';
  const entries = await fetchOnlineCatalog(
    { catalogUrl: 'https://registry.example/v0.1/servers', npmRegistry: 'https://registry.npmmirror.com' },
    async (url) => { requested = String(url); return response({ servers: [OFFICIAL_NPM] }); },
    'files',
  );
  assert.match(requested, /version=latest/);
  assert.match(requested, /search=files/);
  assert.equal(entries[0].package, '@example/files-mcp');
  assert.deepEqual(entries[0].baseArgs, ['-y', '@example/files-mcp@1.2.3']);
  assert.deepEqual(entries[0].suggestedArgs, ['--root', '<必填:root>']);
  assert.equal(entries[0].variables[0].secret, true);
});

test('MCP market falls back to a bundled offline catalog when the Registry is blocked', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'eac-mcp-market-offline-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = await listMcpMarket({ dshHome: home, fetchImpl: async () => { throw new Error('blocked in region'); } });
  assert.equal(result.source, 'builtin');
  assert.ok(result.entries.length >= 6);
  assert.match(result.warning, /内置离线目录/);
  assert.equal(result.config.npmRegistry, 'https://registry.npmmirror.com');
});

test('market install stays disabled, validates required values, and adds the npm mirror', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'eac-mcp-market-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await saveMcpMarketConfig(home, { catalogUrl: 'https://registry.example/servers', npmRegistry: 'https://registry.npmmirror.com' });
  await listMcpMarket({ dshHome: home, refresh: true, fetchImpl: async () => response({ servers: [OFFICIAL_NPM] }) });
  await assert.rejects(
    () => prepareMcpMarketInstall(home, { id: 'io.example/files', serverName: 'files', extraArgs: ['--root', '<必填:root>'], env: {} }),
    /占位符/,
  );
  const prepared = await prepareMcpMarketInstall(home, {
    id: 'io.example/files', serverName: 'files', extraArgs: ['--root', '/safe/workspace'], env: { EXAMPLE_TOKEN: 'secret' },
  });
  assert.equal(prepared.config.enabled, false);
  assert.equal(prepared.config.env.npm_config_registry, 'https://registry.npmmirror.com');
  const added = addMcpEntry('', prepared.config);
  const listed = listMcpEntries(added.patch);
  assert.equal(listed[0].enabled, false);
  assert.equal(listed[0].marketPackage, '@example/files-mcp');
  assert.doesNotMatch(JSON.stringify(listed), /secret/);
});

test('remote Registry entries keep required headers local and disabled', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'eac-mcp-market-remote-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const remote = {
    server: {
      name: 'com.example/remote', title: 'Remote', version: '1.0.0',
      remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp', headers: [{ name: 'Authorization', isRequired: true, isSecret: true }] }],
    },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
  };
  await listMcpMarket({ dshHome: home, refresh: true, fetchImpl: async () => response({ servers: [remote] }) });
  await assert.rejects(() => prepareMcpMarketInstall(home, { id: 'com.example/remote', headers: {} }), /Authorization/);
  const prepared = await prepareMcpMarketInstall(home, { id: 'com.example/remote', serverName: 'remote', headers: { Authorization: 'Bearer local' } });
  assert.equal(prepared.config.transport, 'streamable-http');
  assert.equal(prepared.config.enabled, false);
});
