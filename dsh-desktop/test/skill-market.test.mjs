import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  frontmatterOf,
  installMarketSkill,
  listSkillMarket,
  parseSkillsShCatalog,
  previewMarketSkill,
  saveMarketConfig,
} from '../assets/plugins/dsh-file-changes/lib/skill-market.js';

const COMMIT = 'a'.repeat(40);
const SKILL_MD = Buffer.from('---\nname: demo\ndescription: A safe demo skill\n---\n\n# Demo\n', 'utf8');
const REFERENCE = Buffer.from('Never execute repository scripts.\n', 'utf8');
const gitHash = (content) => createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
const SKILL_SHA = gitHash(SKILL_MD);
const REF_SHA = gitHash(REFERENCE);

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function githubFetch({ symlink = false } = {}) {
  return async (url) => {
    const path = new URL(url).pathname;
    if (path === '/repos/example/repo') return jsonResponse({ name: 'repo', default_branch: 'main' });
    if (path === '/repos/example/repo/commits/main') return jsonResponse({ sha: COMMIT });
    if (path === `/repos/example/repo/git/trees/${COMMIT}`) {
      return jsonResponse({ truncated: false, tree: [
        { path: 'skills/demo/SKILL.md', type: 'blob', mode: '100644', sha: SKILL_SHA, size: SKILL_MD.length },
        { path: 'skills/demo/references/guide.md', type: 'blob', mode: '100644', sha: REF_SHA, size: REFERENCE.length },
        ...(symlink ? [{ path: 'skills/demo/unsafe-link', type: 'blob', mode: '120000', sha: 'd'.repeat(40), size: 8 }] : []),
      ] });
    }
    if (path === `/repos/example/repo/git/blobs/${SKILL_SHA}`) return jsonResponse({ encoding: 'base64', content: SKILL_MD.toString('base64') });
    if (path === `/repos/example/repo/git/blobs/${REF_SHA}`) return jsonResponse({ encoding: 'base64', content: REFERENCE.toString('base64') });
    throw new Error(`unexpected request: ${url}`);
  };
}

test('skills.sh escaped catalog is parsed and invalid entries are ignored', () => {
  const html = String.raw`x \"source\":\"vercel-labs/skills\",\"skillId\":\"find-skills\",\"name\":\"find-skills\",\"installs\":2962019,\"isOfficial\":true y`;
  assert.deepEqual(parseSkillsShCatalog(html), [{
    source: 'vercel-labs/skills',
    skillId: 'find-skills',
    name: 'find-skills',
    description: '',
    installs: 2962019,
    isOfficial: true,
  }]);
});

test('frontmatter accepts plain and folded YAML strings', () => {
  assert.deepEqual(frontmatterOf(SKILL_MD.toString('utf8')), { name: 'demo', description: 'A safe demo skill' });
  assert.deepEqual(frontmatterOf('---\nname: folded\ndescription: >-\n  First line\n  second line\n---\n'), {
    name: 'folded', description: 'First line second line',
  });
  assert.throws(() => frontmatterOf('# no frontmatter'), /frontmatter/);
});

test('market falls back to bundled catalog when China-facing network sources fail', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'eac-market-offline-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = await listSkillMarket({ dshHome: home, fetchImpl: async () => { throw new Error('network blocked'); } });
  assert.equal(result.source, 'builtin');
  assert.ok(result.entries.length >= 20);
  assert.match(result.warning, /内置离线目录/);
});

test('preview pins the repository commit and returns SKILL.md without running code', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'eac-market-preview-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const preview = await previewMarketSkill({ dshHome: home, source: 'example/repo', skillId: 'demo', fetchImpl: githubFetch() });
  assert.equal(preview.commit, COMMIT);
  assert.equal(preview.path, 'skills/demo');
  assert.equal(preview.fileCount, 2);
  assert.match(preview.content, /# Demo/);
});

test('safe installer writes a disabled Skill atomically with source hashes', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'eac-market-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await saveMarketConfig(home, { catalogUrl: 'https://mirror.example/catalog.json', githubApiBase: 'https://github-api.example' });
  const installed = await installMarketSkill({ dshHome: home, source: 'example/repo', skillId: 'demo', fetchImpl: githubFetch() });
  assert.equal(installed.enabled, false);
  await stat(join(home, 'skills', 'demo', 'SKILL.md.disabled'));
  assert.equal(await readFile(join(home, 'skills', 'demo', 'references', 'guide.md'), 'utf8'), REFERENCE.toString('utf8'));
  const manifest = JSON.parse(await readFile(join(home, 'skills', 'demo', '.eac-market.json'), 'utf8'));
  assert.equal(manifest.commit, COMMIT);
  assert.equal(manifest.source, 'example/repo');
  assert.equal(manifest.enabled, false);
  assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  await assert.rejects(() => installMarketSkill({ dshHome: home, source: 'example/repo', skillId: 'demo', fetchImpl: githubFetch() }), /already installed/);
});

test('safe installer rejects repository symlinks before writing the final directory', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'eac-market-link-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(
    () => installMarketSkill({ dshHome: home, source: 'example/repo', skillId: 'demo', fetchImpl: githubFetch({ symlink: true }) }),
    /symbolic link or submodule/,
  );
  await assert.rejects(() => stat(join(home, 'skills', 'demo')), /ENOENT/);
});
