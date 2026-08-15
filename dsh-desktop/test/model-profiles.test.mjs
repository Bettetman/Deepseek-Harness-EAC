import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deleteModelProfile,
  readModelProfiles,
  saveModelProfile,
  switchModelProvider,
  switchModelProfile,
} from '../assets/plugins/dsh-file-changes/lib/model-profiles.js';

function context({ running = false } = {}) {
  const saved = [];
  return {
    saved,
    llm: {
      resolveCallConfig: async (selection) => ({ ...selection }),
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'xiaomi', name: 'xiaomi' }],
      listModels: async (provider) => provider === 'xiaomi'
        ? [{ id: 'mimo-v2-pro' }, { id: 'mimo-v2-flash' }]
        : [{ id: 'deepseek-chat' }],
    },
    agents: {
      list: () => running ? [{ id: 'active-session', status: 'running' }] : [{ id: 'idle-session', status: 'idle' }],
    },
    agentDefaultModel: {
      currentSelection: () => saved.at(-1) || { provider: 'deepseek', model: 'deepseek-chat' },
      saveSelection: async (selection) => { saved.push(selection); },
    },
  };
}

test('model switch profiles persist multiple providers without storing API keys', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'eac-model-profiles-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = await saveModelProfile(home, { name: 'DeepSeek 日常', provider: 'deepseek', model: 'deepseek-chat' });
  const second = await saveModelProfile(home, { name: 'Claude 编程', provider: 'anthropic', model: 'claude-sonnet', reasoningEffort: 'high' });
  const profiles = await readModelProfiles(home);
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0].provider, 'deepseek');
  assert.equal(profiles[1].provider, 'anthropic');
  assert.doesNotMatch(JSON.stringify(profiles), /apiKey|secret|token/i);
  await deleteModelProfile(home, first.id);
  assert.deepEqual((await readModelProfiles(home)).map((item) => item.id), [second.id]);
});

test('model switch is rejected server-side while any agent task is running', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'eac-model-running-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = await saveModelProfile(home, { name: 'Safe switch', provider: 'deepseek', model: 'deepseek-chat' });
  const ctx = context({ running: true });
  await assert.rejects(() => switchModelProfile(ctx, home, profile.id), /任务正在运行/);
  assert.deepEqual(ctx.saved, []);
});

test('idle model switch resolves the route before saving the global default', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'eac-model-idle-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = await saveModelProfile(home, { name: 'Reasoning', provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' });
  const ctx = context();
  const result = await switchModelProfile(ctx, home, profile.id);
  assert.deepEqual(result.selected, { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' });
  assert.deepEqual(ctx.saved, [result.selected]);
});

test('provider activation selects its first configured model and persists it', async () => {
  const ctx = context();
  const result = await switchModelProvider(ctx, 'xiaomi');
  assert.deepEqual(result.selected, { provider: 'xiaomi', model: 'mimo-v2-pro' });
  assert.deepEqual(ctx.saved, [result.selected]);
});

test('provider activation is rejected while a task is running', async () => {
  const ctx = context({ running: true });
  await assert.rejects(() => switchModelProvider(ctx, 'xiaomi'), /任务正在运行/);
  assert.deepEqual(ctx.saved, []);
});

test('model profile validation rejects blank and multiline routing fields', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'eac-model-invalid-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(() => saveModelProfile(home, { name: '', provider: 'deepseek', model: 'chat' }), /profile name/);
  await assert.rejects(() => saveModelProfile(home, { name: 'bad', provider: 'deepseek\nother', model: 'chat' }), /provider/);
});
