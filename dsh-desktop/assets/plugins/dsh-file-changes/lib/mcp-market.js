import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CATALOG_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";
const DEFAULT_NPM_REGISTRY = "https://registry.npmmirror.com";
const REQUEST_TIMEOUT = 15000;
const MAX_ENTRIES = 500;
const MARKET_ID = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,199}$/;
const NPM_PACKAGE = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const SNAPSHOT_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "mcp-market-catalog.json");

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function marketPaths(dshHome) {
  const root = join(resolve(dshHome), "cache", "mcp-market");
  return { root, catalog: join(root, "catalog.json"), config: join(root, "config.json") };
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
  if (url.protocol !== "https:" && url.protocol !== "http:") throw httpError(400, `${label} must be an http(s) URL`);
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeConfig(input = {}) {
  return {
    catalogUrl: validHttpUrl(input.catalogUrl || DEFAULT_CATALOG_URL, "catalog URL"),
    npmRegistry: validHttpUrl(input.npmRegistry || DEFAULT_NPM_REGISTRY, "npm registry"),
  };
}

async function loadMcpMarketConfig(dshHome) {
  const saved = await readJson(marketPaths(dshHome).config, {});
  return normalizeConfig({
    catalogUrl: process.env.DSH_MCP_MARKET_CATALOG_URL || saved.catalogUrl,
    npmRegistry: process.env.DSH_NPM_REGISTRY || saved.npmRegistry,
  });
}

async function saveMcpMarketConfig(dshHome, input) {
  const config = normalizeConfig(input);
  await writeJsonAtomic(marketPaths(dshHome).config, config);
  return config;
}

async function fetchResponse(url, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await (fetchImpl || fetch)(url, {
      headers: { accept: "application/json", "user-agent": "DeepSeek-Harness-Desktop-MCP-Market/3.0.1" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    return response;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function text(value, max = 600) {
  return String(value || "").trim().slice(0, max);
}

function normalizeVariables(rows) {
  const output = [];
  const seen = new Set();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const name = text(raw?.name, 128);
    if (!name || /[\0\r\n]/.test(name) || seen.has(name)) continue;
    seen.add(name);
    const defaultValue = raw?.value ?? raw?.default;
    output.push({
      name,
      description: text(raw?.description, 300),
      required: raw?.isRequired === true || raw?.required === true,
      secret: raw?.isSecret === true || raw?.secret === true,
      ...(defaultValue === undefined ? {} : { default: text(defaultValue, 4096) }),
    });
  }
  return output.slice(0, 64);
}

function argumentDetails(rows) {
  const suggested = [];
  let requiredTokenCount = 0;
  const details = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    const type = raw?.type === "named" ? "named" : "positional";
    const name = text(raw?.name || raw?.valueHint || "参数", 100);
    const required = raw?.isRequired === true;
    const fixed = raw?.value ?? raw?.default;
    const value = fixed === undefined ? (required ? `<必填:${name}>` : "") : text(fixed, 4096);
    if (type === "named") {
      const flag = name.startsWith("-") ? name : `--${name}`;
      if (value) suggested.push(flag, value);
      if (required && fixed === undefined) requiredTokenCount += 2;
    } else {
      if (value) suggested.push(value);
      if (required && fixed === undefined) requiredTokenCount += 1;
    }
    details.push({ type, name, description: text(raw?.description, 300), required, default: fixed === undefined ? "" : text(fixed, 4096) });
  }
  return { suggested, requiredTokenCount, details: details.slice(0, 64) };
}

function normalizeOfficialRow(raw) {
  const server = raw?.server || raw;
  const id = text(server?.name || raw?.id, 200);
  if (!MARKET_ID.test(id)) return null;
  const meta = raw?._meta?.["io.modelcontextprotocol.registry/official"] || {};
  const packages = Array.isArray(server?.packages) ? server.packages : [];
  const npm = packages.find((item) => item?.registryType === "npm" && item?.transport?.type === "stdio" && NPM_PACKAGE.test(text(item?.identifier, 200)));
  const remote = (Array.isArray(server?.remotes) ? server.remotes : []).find((item) => item?.type === "streamable-http" && /^https?:\/\//.test(String(item?.url || "")));
  if (!npm && !remote) return null;
  const title = text(server?.title || server?._meta?.["io.modelcontextprotocol.registry/publisher-provided"]?.title || id, 160);
  const common = {
    id,
    name: title || id,
    description: text(server?.description),
    version: text(server?.version || npm?.version || "", 80),
    repository: /^https?:\/\//.test(String(server?.repository?.url || "")) ? text(server.repository.url, 500) : "",
    website: /^https?:\/\//.test(String(server?.websiteUrl || "")) ? text(server.websiteUrl, 500) : "",
    isOfficial: meta?.status === "active",
  };
  if (npm) {
    const identifier = text(npm.identifier, 200);
    const version = text(npm.version || server?.version || "latest", 80) || "latest";
    const runtimeArgs = (Array.isArray(npm.runtimeArguments) ? npm.runtimeArguments : []).map((item) => text(item?.value, 4096)).filter(Boolean);
    if (!runtimeArgs.includes("-y") && !runtimeArgs.includes("--yes")) runtimeArgs.unshift("-y");
    const args = argumentDetails(npm.packageArguments);
    return {
      ...common,
      transport: "stdio",
      command: "npx",
      package: identifier,
      packageVersion: version,
      baseArgs: [...runtimeArgs, `${identifier}@${version}`],
      suggestedArgs: args.suggested,
      requiredArgTokens: args.requiredTokenCount,
      arguments: args.details,
      variables: normalizeVariables(npm.environmentVariables),
      headers: [],
    };
  }
  return {
    ...common,
    transport: "streamable-http",
    url: validHttpUrl(remote.url, "MCP remote URL"),
    command: "",
    package: "",
    packageVersion: "",
    baseArgs: [],
    suggestedArgs: [],
    requiredArgTokens: 0,
    arguments: [],
    variables: [],
    headers: normalizeVariables(remote.headers),
  };
}

function normalizeSimpleRow(raw) {
  if (raw?.server) return normalizeOfficialRow(raw);
  const id = text(raw?.id || raw?.name, 200);
  if (!MARKET_ID.test(id)) return null;
  const transport = raw?.transport === "streamable-http" ? "streamable-http" : "stdio";
  const common = {
    id,
    name: text(raw?.title || raw?.name || id, 160) || id,
    description: text(raw?.description),
    version: text(raw?.version || "", 80),
    repository: /^https?:\/\//.test(String(raw?.repository || "")) ? text(raw.repository, 500) : "",
    website: /^https?:\/\//.test(String(raw?.website || "")) ? text(raw.website, 500) : "",
    isOfficial: raw?.isOfficial === true,
  };
  if (transport === "streamable-http") {
    let url;
    try { url = validHttpUrl(raw?.url, "MCP remote URL"); } catch { return null; }
    return { ...common, transport, url, command: "", package: "", packageVersion: "", baseArgs: [], suggestedArgs: [], requiredArgTokens: 0, arguments: [], variables: [], headers: normalizeVariables(raw?.headers) };
  }
  const identifier = text(raw?.package || raw?.identifier, 200);
  if (!NPM_PACKAGE.test(identifier)) return null;
  const version = text(raw?.packageVersion || raw?.version || "latest", 80) || "latest";
  const args = argumentDetails(raw?.packageArguments);
  return {
    ...common,
    transport,
    command: "npx",
    package: identifier,
    packageVersion: version,
    baseArgs: ["-y", `${identifier}@${version}`],
    suggestedArgs: Array.isArray(raw?.suggestedArgs) ? raw.suggestedArgs.map((item) => text(item, 4096)).filter(Boolean) : args.suggested,
    requiredArgTokens: Number.isSafeInteger(raw?.requiredArgTokens) ? Math.max(0, raw.requiredArgTokens) : args.requiredTokenCount,
    arguments: args.details,
    variables: normalizeVariables(raw?.variables || raw?.environmentVariables),
    headers: [],
  };
}

function normalizeCatalogEntries(rows) {
  const map = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    let entry;
    try { entry = raw?.server ? normalizeOfficialRow(raw) : normalizeSimpleRow(raw); } catch { entry = null; }
    if (!entry) continue;
    const key = entry.id.toLowerCase();
    if (!map.has(key) || raw?._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest === true) map.set(key, entry);
  }
  return [...map.values()].slice(0, MAX_ENTRIES).sort((a, b) => a.name.localeCompare(b.name));
}

function filterEntries(entries, query) {
  const needle = text(query, 120).toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => [entry.id, entry.name, entry.description, entry.package].some((value) => String(value || "").toLowerCase().includes(needle)));
}

async function fetchOnlineCatalog(config, fetchImpl, query = "") {
  const url = new URL(config.catalogUrl);
  if (!url.searchParams.has("limit")) url.searchParams.set("limit", "100");
  if (!url.searchParams.has("version")) url.searchParams.set("version", "latest");
  if (text(query, 120)) url.searchParams.set("search", text(query, 120));
  const response = await fetchResponse(url, fetchImpl);
  const data = await response.json();
  const entries = normalizeCatalogEntries(Array.isArray(data) ? data : data?.servers || data?.entries);
  if (!entries.length) throw new Error("catalog response contained no compatible npm or streamable-http MCP entries");
  return entries;
}

async function listMcpMarket({ dshHome, refresh = false, query = "", fetchImpl } = {}) {
  if (!dshHome) throw new Error("dshHome is required");
  const paths = marketPaths(dshHome);
  const config = await loadMcpMarketConfig(dshHome);
  const cached = await readJson(paths.catalog, null);
  const snapshot = normalizeCatalogEntries((await readJson(SNAPSHOT_FILE, {}))?.entries);
  let warning = "";
  if (refresh || !cached?.entries?.length) {
    try {
      const online = await fetchOnlineCatalog(config, fetchImpl, query);
      const merged = normalizeCatalogEntries([...(cached?.entries || []), ...online]);
      const saved = { updatedAt: new Date().toISOString(), catalogUrl: config.catalogUrl, entries: merged };
      await writeJsonAtomic(paths.catalog, saved);
      return { entries: filterEntries(online, query), source: "online", updatedAt: saved.updatedAt, config, warning };
    } catch (error) {
      warning = `官方 MCP Registry 不可用，已使用${cached?.entries?.length ? "本地缓存" : "内置离线目录"}：${error?.message || error}`;
    }
  }
  const sourceEntries = cached?.entries?.length ? normalizeCatalogEntries(cached.entries) : snapshot;
  return { entries: filterEntries(sourceEntries, query), source: cached?.entries?.length ? "cache" : "builtin", updatedAt: cached?.updatedAt || "", config, warning };
}

function validateStringMap(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, `${label} must be an object`);
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key || key.length > 128 || /[\0\r\n]/.test(key)) throw httpError(400, `invalid ${label} key`);
    const valueText = String(raw);
    if (valueText.length > 8192) throw httpError(400, `${label} value is too long`);
    output[key] = valueText;
  }
  return output;
}

function validateExtraArgs(value) {
  if (!Array.isArray(value) || value.length > 64) throw httpError(400, "extraArgs must be a JSON array");
  const args = value.map(String);
  if (args.some((arg) => arg.length > 4096 || /[\0\r\n]/.test(arg))) throw httpError(400, "invalid MCP argument");
  return args;
}

async function resolveMarketEntry(dshHome, id) {
  if (!MARKET_ID.test(String(id || ""))) throw httpError(400, "invalid MCP market id");
  const paths = marketPaths(dshHome);
  const cached = normalizeCatalogEntries((await readJson(paths.catalog, {}))?.entries);
  const snapshot = normalizeCatalogEntries((await readJson(SNAPSHOT_FILE, {}))?.entries);
  const entry = [...cached, ...snapshot].find((item) => item.id === id);
  if (!entry) throw httpError(404, "MCP market entry was not found; refresh the market and try again");
  return entry;
}

async function prepareMcpMarketInstall(dshHome, input) {
  const entry = await resolveMarketEntry(dshHome, input?.id);
  const serverName = text(input?.serverName || entry.id.split(/[/:]/).pop(), 64).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!serverName) throw httpError(400, "serverName is invalid");
  if (entry.transport === "stdio") {
    const extraArgs = validateExtraArgs(input?.extraArgs || []);
    if (extraArgs.some((arg) => /<必填[:>]/.test(arg)) || (entry.requiredArgTokens > 0 && extraArgs.length < entry.requiredArgTokens)) {
      throw httpError(400, "请填写此 MCP 清单要求的启动参数，不能保留 <必填:...> 占位符");
    }
    const supplied = validateStringMap(input?.env, "env");
    const env = { npm_config_registry: (await loadMcpMarketConfig(dshHome)).npmRegistry };
    for (const variable of entry.variables) {
      if (variable.default !== undefined) env[variable.name] = variable.default;
      if (supplied[variable.name] !== undefined) env[variable.name] = supplied[variable.name];
      if (variable.required && !String(env[variable.name] || "").trim()) throw httpError(400, `请填写必需环境变量 ${variable.name}`);
    }
    for (const [key, value] of Object.entries(supplied)) env[key] = value;
    return { entry, config: { serverName, transport: "stdio", command: "npx", args: [...entry.baseArgs, ...extraArgs], env, enabled: false } };
  }
  const supplied = validateStringMap(input?.headers, "headers");
  const headers = {};
  for (const item of entry.headers) {
    if (item.default !== undefined) headers[item.name] = item.default;
    if (supplied[item.name] !== undefined) headers[item.name] = supplied[item.name];
    if (item.required && !String(headers[item.name] || "").trim()) throw httpError(400, `请填写必需请求头 ${item.name}`);
  }
  for (const [key, value] of Object.entries(supplied)) headers[key] = value;
  return { entry, config: { serverName, transport: "streamable-http", url: entry.url, headers, enabled: false } };
}

export {
  DEFAULT_CATALOG_URL,
  DEFAULT_NPM_REGISTRY,
  fetchOnlineCatalog,
  listMcpMarket,
  loadMcpMarketConfig,
  normalizeCatalogEntries,
  prepareMcpMarketInstall,
  saveMcpMarketConfig,
};
