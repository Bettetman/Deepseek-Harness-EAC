import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function source(...parts) {
  return readFileSync(join(root, ...parts), 'utf8');
}

function sectionOrder(src, id) {
  const match = src.match(new RegExp(`id:\\s*["']${id}["'][\\s\\S]{0,160}?order:\\s*(\\d+)`));
  assert.ok(match, `settings section ${id} must declare an order`);
  return Number(match[1]);
}

test('settings merge vision quick setup and keep managers after models', () => {
  const easySetup = source('assets', 'plugins', 'dsh-easy-setup', 'lib', 'client.js');
  const soul = source('assets', 'plugins', 'dsh-soul-md', 'client.js');
  const skin = source('assets', 'plugins', 'dsh-skin-switch', 'lib', 'client.js');
  const vision = source('assets', 'plugins', 'dsh-tool-vision', 'client.js');
  const layout = source('assets', 'plugins', 'dsh-vscode-layout', 'lib', 'client.js');
  const officialPlugins = source('node_modules', '@deepseek-ai', 'dsh-client-ui-settings-plugins', 'lib', 'client.js');

  assert.doesNotMatch(easySetup, /id:\s*["']easy-vision["']/);
  assert.doesNotMatch(easySetup, /function\s+VisionQuick\b/);
  assert.match(vision, /var\s+PROVIDERS\s*=\s*\[/);
  assert.match(vision, /quickTitle:\s*["']快速配置/);
  assert.match(easySetup, /模型管理/);
  assert.match(easySetup, /插件管理/);

  assert.doesNotMatch(easySetup, /id:\s*["']easy-persona["']/);
  assert.doesNotMatch(easySetup, /id:\s*["']easy-migration["']/);
  assert.match(easySetup, /id:\s*["']persona["'][\s\S]{0,220}?children:\s*\{\s*["']settings\.persona\.panel["']/);
  assert.match(easySetup, /id:\s*["']advanced["'][\s\S]{0,220}?children:\s*\{\s*["']settings\.advanced\.panel["']/);
  assert.match(easySetup, /renderSlot\(["']settings\.persona\.panel["'][\s\S]*only:\s*["']content["']/);
  assert.match(easySetup, /renderSlot\(["']settings\.persona\.panel["'][\s\S]*only:\s*["']settings["']/);
  assert.match(soul, /name:\s*["']settings\.persona\.panel["'][\s\S]{0,100}?id:\s*["']settings["']/);
  assert.doesNotMatch(soul, /name:\s*["']settings\.section["']/);
  assert.match(skin, /name:\s*["']settings\.advanced\.panel["'][\s\S]{0,100}?id:\s*["']skin["']/);
  assert.doesNotMatch(skin, /name:\s*["']settings\.plugins\.tab["']/);
  assert.doesNotMatch(skin, /来源与版权|Sources & Credits|版权归原作者|creditsTitle|licMaid|creditMaid|repoMaid/);
  assert.doesNotMatch(skin, /className:\s*s\.(?:src|credits)/);

  const orders = {
    model: 10,
    skills: sectionOrder(layout, 'skills'),
    mcp: sectionOrder(layout, 'mcp'),
    plugins: sectionOrder(officialPlugins, 'plugins'),
    vision: sectionOrder(vision, 'tool-vision'),
    persona: sectionOrder(easySetup, 'persona'),
    advanced: sectionOrder(easySetup, 'advanced'),
  };
  assert.deepEqual(orders, { model: 10, skills: 11, mcp: 12, plugins: 15, vision: 20, persona: 24, advanced: 90 });
});
