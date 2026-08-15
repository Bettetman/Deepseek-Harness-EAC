import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CATALOG_URL = "https://skills.sh/";
const DEFAULT_GITHUB_API = "https://api.github.com";
const MAX_FILES = 128;
const MAX_FILE_SIZE = 1024 * 1024;
const MAX_TOTAL_SIZE = 5 * 1024 * 1024;
const MAX_SKILL_MD_SIZE = 512 * 1024;
const REQUEST_TIMEOUT = 15000;
const MARKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SNAPSHOT_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "skill-market-catalog.json");

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function marketPaths(dshHome) {
  const root = join(resolve(dshHome), "cache", "skill-market");
  return {
    root,
    catalog: join(root, "catalog.json"),
    config: join(root, "config.json"),
    skills: join(resolve(dshHome), "skills"),
  };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { return fallback; }
}

async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + ".tmp-" + randomBytes(6).toString("hex");
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function validHttpUrl(raw, label) {
  let url;
  try { url = new URL(String(raw || "").trim()); }
  catch { throw httpError(400, `${label} must be an http(s) URL`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw httpError(400, `${label} must be an http(s) URL`);
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeConfig(input = {}) {
  return {
    catalogUrl: validHttpUrl(input.catalogUrl || DEFAULT_CATALOG_URL, "catalog URL"),
    githubApiBase: validHttpUrl(input.githubApiBase || DEFAULT_GITHUB_API, "GitHub API base"),
  };
}

async function loadMarketConfig(dshHome) {
  const paths = marketPaths(dshHome);
  const saved = await readJson(paths.config, {});
  return normalizeConfig({
    catalogUrl: process.env.DSH_SKILL_MARKET_CATALOG_URL || saved.catalogUrl,
    githubApiBase: process.env.DSH_GITHUB_API_BASE || saved.githubApiBase,
  });
}

async function saveMarketConfig(dshHome, input) {
  const config = normalizeConfig(input);
  await writeJsonAtomic(marketPaths(dshHome).config, config);
  return config;
}

async function fetchResponse(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT);
  const headers = {
    accept: options.accept || "application/vnd.github+json, application/json, text/html;q=0.9",
    "user-agent": "Deepseek-Harness-EAC-Skill-Market/1.0",
    ...(options.headers || {}),
  };
  if (process.env.GITHUB_TOKEN && new URL(url).hostname.includes("github")) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  try {
    const response = await (options.fetchImpl || fetch)(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    return response;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCatalogEntries(entries) {
  const seen = new Set();
  const output = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    const source = String(raw?.source || raw?.repo || "").trim();
    const skillId = String(raw?.skillId || raw?.id || raw?.name || "").trim();
    if (!validRepository(source) || !MARKET_ID.test(skillId)) continue;
    const key = `${source}:${skillId}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      source,
      skillId,
      name: String(raw?.name || skillId).trim().slice(0, 160) || skillId,
      description: String(raw?.description || "").trim().slice(0, 600),
      installs: Number.isSafeInteger(Number(raw?.installs)) ? Math.max(0, Number(raw.installs)) : 0,
      isOfficial: raw?.isOfficial === true,
    });
  }
  return output.sort((a, b) => b.installs - a.installs || a.name.localeCompare(b.name));
}

function parseSkillsShCatalog(text) {
  const entries = [];
  const patterns = [
    /\\"source\\":\\"([^"\\]+)\\",\\"skillId\\":\\"([^"\\]+)\\",\\"name\\":\\"([^"\\]+)\\",\\"installs\\":(\d+)(?:,\\"isOfficial\\":(true|false))?/g,
    /"source":"([^"\\]+)","skillId":"([^"\\]+)","name":"([^"\\]+)","installs":(\d+)(?:,"isOfficial":(true|false))?/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      entries.push({ source: match[1], skillId: match[2], name: match[3], installs: Number(match[4]), isOfficial: match[5] === "true" });
    }
    if (entries.length) break;
  }
  return normalizeCatalogEntries(entries);
}

async function fetchOnlineCatalog(config, fetchImpl) {
  const response = await fetchResponse(config.catalogUrl, { fetchImpl, accept: "application/json, text/html;q=0.9" });
  const text = await response.text();
  let entries = [];
  try {
    const data = JSON.parse(text);
    entries = normalizeCatalogEntries(Array.isArray(data) ? data : data?.skills || data?.entries);
  } catch {
    entries = parseSkillsShCatalog(text);
  }
  if (!entries.length) throw new Error("catalog response contained no valid Skill entries");
  return entries;
}

async function listSkillMarket({ dshHome, refresh = false, fetchImpl } = {}) {
  if (!dshHome) throw new Error("dshHome is required");
  const paths = marketPaths(dshHome);
  const config = await loadMarketConfig(dshHome);
  const cached = await readJson(paths.catalog, null);
  const snapshot = normalizeCatalogEntries((await readJson(SNAPSHOT_FILE, {}))?.entries);
  let warning = "";

  if (refresh || !cached?.entries?.length) {
    try {
      const entries = await fetchOnlineCatalog(config, fetchImpl);
      const saved = { updatedAt: new Date().toISOString(), catalogUrl: config.catalogUrl, entries };
      await writeJsonAtomic(paths.catalog, saved);
      return { entries, source: "online", updatedAt: saved.updatedAt, config, warning };
    } catch (error) {
      warning = `在线目录不可用，已使用${cached?.entries?.length ? "本地缓存" : "内置离线目录"}：${error?.message || error}`;
    }
  }
  if (cached?.entries?.length) {
    return { entries: normalizeCatalogEntries(cached.entries), source: "cache", updatedAt: cached.updatedAt || "", config, warning };
  }
  return { entries: snapshot, source: "builtin", updatedAt: "", config, warning };
}

function assertMarketRef(input) {
  const source = String(input?.source || "").trim();
  const skillId = String(input?.skillId || "").trim();
  if (!validRepository(source)) throw httpError(400, "invalid GitHub repository");
  if (!MARKET_ID.test(skillId)) throw httpError(400, "invalid Skill id");
  return { source, skillId };
}

function validRepository(source) {
  if (!REPO.test(source)) return false;
  return source.split("/").every((part) => part !== "." && part !== ".." && part.length <= 100);
}

function githubHeaders() {
  return { accept: "application/vnd.github+json" };
}

async function githubJson(apiBase, path, fetchImpl) {
  const response = await fetchResponse(apiBase + path, { fetchImpl, headers: githubHeaders() });
  return response.json();
}

function decodeBlob(blob, expectedSha) {
  if (blob?.encoding !== "base64" || typeof blob?.content !== "string") throw new Error("GitHub returned an unsupported blob encoding");
  const content = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
  if (expectedSha) {
    const actual = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    if (actual.toLowerCase() !== String(expectedSha).toLowerCase()) throw httpError(422, "downloaded Git blob hash does not match the pinned repository tree");
  }
  return content;
}

function frontmatterOf(text) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/.exec(text);
  if (!match) throw httpError(422, "SKILL.md has no YAML frontmatter");
  const scalar = (name) => {
    const row = new RegExp(`^${name}:\\s*(.*?)\\s*$`, "m").exec(match[1]);
    if (!row) return "";
    const value = row[1].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const rest = match[1].slice(row.index + row[0].length);
      const lines = [];
      for (const line of rest.split(/\r?\n/).slice(1)) {
        if (!/^\s+/.test(line) && line.trim()) break;
        if (line.trim()) lines.push(line.trim());
      }
      return lines.join(value.startsWith(">") ? " " : "\n").trim();
    }
    return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, a, b) => a ?? b).trim();
  };
  const name = scalar("name");
  const description = scalar("description");
  if (!name || !description) throw httpError(422, "SKILL.md frontmatter needs string name and description");
  return { name, description };
}

function rankSkillPath(path, skillId) {
  if (path === "SKILL.md") return 50;
  const prefixes = ["skills/", ".agents/skills/", ".claude/skills/", ".codex/skills/"];
  const prefix = prefixes.findIndex((item) => path === `${item}${skillId}/SKILL.md`);
  return prefix >= 0 ? 100 - prefix : 10;
}

async function resolveRepositorySkill({ dshHome, source, skillId, fetchImpl }) {
  ({ source, skillId } = assertMarketRef({ source, skillId }));
  const { githubApiBase } = await loadMarketConfig(dshHome);
  const apiBase = githubApiBase.replace(/\/$/, "");
  const repoPath = `/repos/${source}`;
  const repo = await githubJson(apiBase, repoPath, fetchImpl);
  const branch = String(repo?.default_branch || "main");
  const commit = await githubJson(apiBase, `${repoPath}/commits/${encodeURIComponent(branch)}`, fetchImpl);
  const sha = String(commit?.sha || "");
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error("GitHub did not return a valid commit SHA");
  const tree = await githubJson(apiBase, `${repoPath}/git/trees/${sha}?recursive=1`, fetchImpl);
  if (tree?.truncated) throw httpError(422, "repository tree is too large to inspect safely");
  const rows = Array.isArray(tree?.tree) ? tree.tree : [];
  const suffix = `/${skillId}/SKILL.md`.toLowerCase();
  const candidates = rows.filter((row) => row?.type === "blob" && typeof row.path === "string" &&
    (row.path.toLowerCase().endsWith(suffix) || (row.path === "SKILL.md" && skillId.toLowerCase() === String(repo?.name || "").toLowerCase())));
  if (!candidates.length) throw httpError(404, `Skill ${skillId} was not found in ${source}`);
  candidates.sort((a, b) => rankSkillPath(b.path, skillId) - rankSkillPath(a.path, skillId));

  let selected;
  let skillMd;
  let metadata;
  for (const candidate of candidates) {
    if (Number(candidate.size) > MAX_SKILL_MD_SIZE) continue;
    const blob = await githubJson(apiBase, `${repoPath}/git/blobs/${candidate.sha}`, fetchImpl);
    const content = decodeBlob(blob, candidate.sha);
    try {
      const parsed = frontmatterOf(content.toString("utf8"));
      if (parsed.name.toLowerCase() !== skillId.toLowerCase() && candidates.length > 1) continue;
      selected = candidate;
      skillMd = content;
      metadata = parsed;
      break;
    } catch (error) {
      if (candidates.length === 1) throw error;
    }
  }
  if (!selected) throw httpError(422, "no valid SKILL.md matched this catalog entry");

  const skillRoot = dirname(selected.path) === "." ? "" : dirname(selected.path);
  const prefix = skillRoot ? skillRoot + "/" : "";
  const files = [];
  let totalSize = 0;
  for (const row of rows) {
    if (typeof row?.path !== "string" || (prefix && !row.path.startsWith(prefix))) continue;
    if (!prefix && row.path.includes("/")) continue;
    const rel = prefix ? row.path.slice(prefix.length) : row.path;
    if (!rel || rel.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) throw httpError(422, "repository contains an unsafe path");
    if (row.mode === "120000" || row.type === "commit") throw httpError(422, "Skill contains a symbolic link or submodule");
    if (row.type !== "blob") continue;
    const size = Number(row.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_SIZE) throw httpError(413, `Skill file is too large: ${rel}`);
    totalSize += size;
    if (totalSize > MAX_TOTAL_SIZE) throw httpError(413, "Skill is larger than the 5 MB safety limit");
    files.push({ path: rel, sha: row.sha, size });
  }
  if (files.length > MAX_FILES) throw httpError(413, `Skill has more than ${MAX_FILES} files`);
  return { source, skillId, sha, apiBase, repoPath, skillRoot, files, skillMd, metadata };
}

async function previewMarketSkill(options) {
  const resolved = await resolveRepositorySkill(options);
  return {
    source: resolved.source,
    skillId: resolved.skillId,
    commit: resolved.sha,
    path: resolved.skillRoot || "/",
    name: resolved.metadata.name,
    description: resolved.metadata.description,
    fileCount: resolved.files.length,
    totalSize: resolved.files.reduce((sum, file) => sum + file.size, 0),
    content: resolved.skillMd.toString("utf8"),
  };
}

function safeInstallTarget(root, id) {
  if (!MARKET_ID.test(id)) throw httpError(400, "invalid Skill id");
  const target = resolve(root, id);
  const rel = relative(resolve(root), target);
  if (!rel || rel.startsWith(".." + sep) || rel === "..") throw httpError(403, "Skill path escapes the installation directory");
  return target;
}

function safeChildTarget(root, path) {
  const parts = String(path || "").split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
    throw httpError(422, "Skill contains an unsafe file path");
  }
  const target = resolve(root, ...parts);
  const rel = relative(resolve(root), target);
  if (!rel || rel.startsWith(".." + sep) || rel === "..") throw httpError(403, "Skill file escapes the installation directory");
  return target;
}

async function installMarketSkill(options) {
  const resolved = await resolveRepositorySkill(options);
  const paths = marketPaths(options.dshHome);
  await mkdir(paths.skills, { recursive: true, mode: 0o700 });
  const target = safeInstallTarget(paths.skills, resolved.skillId);
  try { await stat(target); throw httpError(409, `Skill ${resolved.skillId} is already installed`); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const temp = join(paths.skills, `.market-install-${resolved.skillId}-${randomBytes(6).toString("hex")}`);
  const manifestFiles = [];
  try {
    await mkdir(temp, { mode: 0o700 });
    for (const file of resolved.files) {
      const output = safeChildTarget(temp, file.path);
      const blob = file.path === "SKILL.md"
        ? resolved.skillMd
        : decodeBlob(await githubJson(resolved.apiBase, `${resolved.repoPath}/git/blobs/${file.sha}`, options.fetchImpl), file.sha);
      if (blob.length !== file.size || blob.length > MAX_FILE_SIZE) throw httpError(422, `downloaded file size does not match: ${file.path}`);
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      const actual = file.path === "SKILL.md" ? output + ".disabled" : output;
      await writeFile(actual, blob, { flag: "wx", mode: 0o600 });
      manifestFiles.push({ path: file.path === "SKILL.md" ? "SKILL.md.disabled" : file.path, sha256: createHash("sha256").update(blob).digest("hex"), size: blob.length });
    }
    if (!manifestFiles.some((file) => file.path === "SKILL.md.disabled")) throw httpError(422, "Skill package did not include SKILL.md");
    const manifest = {
      schemaVersion: 1,
      installedAt: new Date().toISOString(),
      source: resolved.source,
      skillId: resolved.skillId,
      commit: resolved.sha,
      sourcePath: resolved.skillRoot || "/",
      enabled: false,
      files: manifestFiles,
    };
    await writeFile(join(temp, ".eac-market.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temp, target);
    return { id: resolved.skillId, enabled: false, commit: resolved.sha, fileCount: manifestFiles.length };
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export {
  DEFAULT_CATALOG_URL,
  DEFAULT_GITHUB_API,
  fetchOnlineCatalog,
  frontmatterOf,
  installMarketSkill,
  listSkillMarket,
  loadMarketConfig,
  normalizeCatalogEntries,
  parseSkillsShCatalog,
  previewMarketSkill,
  saveMarketConfig,
};
