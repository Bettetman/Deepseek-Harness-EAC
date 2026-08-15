import { z } from "zod";
import { lstat, mkdir, open, opendir, readdir, realpath, rename, stat, readFile, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Socket } from "node:net";
import { zstdDecompressSync } from "node:zlib";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { isPathInside, pathKey, sameOriginMutation, validSegment } from "./ide-paths.js";
import { addMcpEntry, deleteMcpEntry, listMcpEntries, toggleMcpEntry } from "./ide-management.js";
import { installMarketSkill, listSkillMarket, previewMarketSkill, saveMarketConfig } from "./skill-market.js";
import { listMcpMarket, prepareMcpMarketInstall, saveMcpMarketConfig } from "./mcp-market.js";
import { deleteModelProfile, listModelCatalog, readModelProfiles, runningAgents, sameSelection, saveModelProfile, switchModelProfile, switchModelProvider } from "./model-profiles.js";

const execFileP = promisify(execFile);

// 会话文件更改投影：纯函数折叠 tool/result 事件中已持久化的
// meta.diffs（每个元素 = { path, oldText, newText }，来自 ctx.fs 写前锁内全文）。
// 零写入、零格式变更 —— 只读复用官方已落盘的数据，因此对 dsh 升级完全稳定。
//
// 另外提供四组 webServer 路由（均仅接受回环地址请求）：
//   GET /api/dsh-files/list?path=...     —— 一层目录列表（「全部文件」树）
//   GET /dsh-files/static/<绝对路径>     —— 静态文件服务（HTML 站内侧边预览，
//                                           相对资源引用随 URL 路径自然解析）
//   GET /api/dsh-files/ports             —— 本机回环监听端口（端口预览候选）
//   GET /api/dsh-files/check?url=...     —— 检查回环 URL 是否在线（HTTP 状态）
//   GET /api/dsh-files/session-cwd?sessionId=... —— 按会话 ID 查会话日志头的
//                                           cwd（客户端视图确定项目根目录用）

const MAX_TEXT = 256 * 1024; // 单侧文本上限，防止投影体积失控
const MAX_CHANGES = 2000;   // 单会话变更记录上限

const fileChangesSchema = z.object({
  changes: z.array(z.object({
    seq: z.number().int().nonnegative(),
    time: z.number(),
    path: z.string(),
    op: z.string(),
    oldText: z.string(),
    newText: z.string()
  })),
  truncated: z.boolean().optional()
});

function clamp(text) {
  return typeof text === "string" && text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

const fileChangesProjectionDefinition = {
  key: "fileChanges",
  // dsh 0.1.0-rc.6 requires stateVersion (non-negative integer) and a
  // `view` that shapes the raw state into the schema-validated value.
  stateVersion: 0,
  schema: fileChangesSchema,
  init: () => ({ changes: [], truncated: false }),
  view: (state) => state,
  apply: (state, event) => {
    if (event.type !== "tool/result") return state;
    const diffs = event.data?.meta?.diffs;
    if (!Array.isArray(diffs) || diffs.length === 0) return state;
    const additions = [];
    for (const d of diffs) {
      const path = typeof d?.path === "string" ? d.path.trim() : "";
      if (!path) continue;
      const oldText = typeof d.oldText === "string" ? d.oldText : "";
      const newText = typeof d.newText === "string" ? d.newText : "";
      const op = oldText === "" && newText !== "" ? "create"
        : newText === "" && oldText !== "" ? "delete"
        : "edit";
      additions.push({
        seq: event.seq,
        time: typeof event.time === "number" ? event.time : 0,
        path,
        op,
        oldText: clamp(oldText),
        newText: clamp(newText)
      });
    }
    if (additions.length === 0) return state;
    const merged = [...state.changes, ...additions];
    if (merged.length <= MAX_CHANGES) return { changes: merged, truncated: state.truncated };
    return { changes: merged.slice(-MAX_CHANGES), truncated: true };
  }
};

// ---------------------------------------------------------------------------
// 项目文件树：GET /api/dsh-files/list?path=<绝对路径>
// 返回该目录的一层子项：{ path, entries: [{ name, dir, size, mtime }] }
// ---------------------------------------------------------------------------

const LIST_ROUTE = "/api/dsh-files/list";

function isLoopback(req) {
  const ra = req.socket && req.socket.remoteAddress;
  return ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(data.length)
  });
  res.end(data);
}

/** 读一层目录：目录在前、文件在后，各自按名称排序；附带文件大小与修改时间。 */
async function listOneLevel(dirPath) {
  const handle = await opendir(dirPath);
  const entries = [];
  try {
    for await (const d of handle) {
      entries.push({ name: d.name, dir: d.isDirectory() });
    }
  } finally {
    // for-await 结束时 Node 会自动关闭句柄；显式 close 只兜底提前退出的情况。
    try { await handle.close(); } catch {}
  }
  const out = [];
  for (const e of entries) {
    let size = 0;
    let mtime = 0;
    try {
      const st = await stat(join(dirPath, e.name));
      if (st.isDirectory() && !e.dir) e.dir = true; // 符号链接指向目录
      else if (st.isFile() && e.dir) e.dir = false; // 符号链接指向文件
      size = st.isFile() ? st.size : 0;
      mtime = st.mtimeMs;
    } catch {
      // 不可 stat 的条目（如损坏的符号链接）仍显示，只是没有大小/时间。
    }
    out.push({ name: e.name, dir: e.dir, size, mtime });
  }
  out.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  return out;
}

async function handleListRoute(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET" });
    res.end();
    return;
  }
  if (!isLoopback(req)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  let url;
  try {
    url = new URL(req.url, "http://127.0.0.1");
  } catch {
    sendJson(res, 400, { error: "bad request URL" });
    return;
  }
  const dirPath = (url.searchParams.get("path") || "").trim();
  if (!dirPath || !isAbsolute(dirPath)) {
    sendJson(res, 400, { error: "path must be an absolute path" });
    return;
  }
  try {
    const entries = await listOneLevel(dirPath);
    sendJson(res, 200, { path: dirPath, entries });
  } catch (err) {
    const code = err && (err.code === "ENOENT" || err.code === "ENOTDIR" || err.code === "EACCES" || err.code === "EPERM") ? 404 : 500;
    sendJson(res, code, { error: String((err && err.message) || err) });
  }
}

// ---------------------------------------------------------------------------
// 静态文件服务：GET /dsh-files/static/<绝对路径>
// 路径直接嵌入 URL，HTML 的相对资源引用（./css、../img）随浏览器 URL 解析，
// 因此站内预览与本地 file:// 行为一致。
// ---------------------------------------------------------------------------

const STATIC_PREFIX = "/dsh-files/static/";

const MIME = {
  ".html": "text/html", ".htm": "text/html", ".xhtml": "application/xhtml+xml",
  ".css": "text/css",
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
  ".json": "application/json", ".map": "application/json",
  ".txt": "text/plain", ".md": "text/plain", ".csv": "text/plain",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".avif": "image/avif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4", ".webm": "video/webm", ".ogg": "video/ogg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".pdf": "application/pdf", ".xml": "application/xml"
};

const TEXT_MIME = /^(text\/|application\/(json|javascript|xhtml\+xml|xml)|image\/svg)/;

function mimeFor(p) {
  return MIME[extname(p).toLowerCase()] || "application/octet-stream";
}

/** 从 /dsh-files/static/<path> 的 pathname 还原绝对路径；非法/不支持返回空串。 */
function pathFromStaticUrl(pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname.slice(STATIC_PREFIX.length));
  } catch {
    return "";
  }
  // 浏览器把 "//server" 折叠成 "/server"；仅恢复盘符路径（UNC 预览不支持）。
  if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  if (!isAbsolute(p)) return "";
  return p;
}

async function handleStaticRoute(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }
  if (!isLoopback(req)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  let pathname;
  try {
    pathname = new URL(req.url, "http://127.0.0.1").pathname;
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const p = pathFromStaticUrl(pathname);
  if (!p) {
    res.writeHead(400);
    res.end("bad path");
    return;
  }
  try {
    const st = await stat(p);
    if (!st.isFile()) {
      res.writeHead(404);
      res.end("not a file");
      return;
    }
    const data = await readFile(p);
    const mime = mimeFor(p);
    res.writeHead(200, {
      "content-type": TEXT_MIME.test(mime) ? mime + "; charset=utf-8" : mime,
      "content-length": String(data.length),
      "cache-control": "no-store"
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch (err) {
    const code = err && (err.code === "ENOENT" || err.code === "EACCES" || err.code === "EPERM") ? 404 : 500;
    res.writeHead(code);
    res.end(code === 404 ? "not found" : "internal error");
  }
}

// ---------------------------------------------------------------------------
// 端口探测：GET /api/dsh-files/ports —— 本机回环监听端口（预览候选）
// ---------------------------------------------------------------------------

const COMMON_DEV_PORTS = [3000, 3001, 3005, 3006, 4200, 4321, 5000, 5001, 5173, 5174, 5500, 6006, 8000, 8080, 8081, 8787, 8888, 9000, 1313];

let portsCache = { at: 0, value: null };

function probePort(port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const sock = new Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.connect(port, "127.0.0.1");
  });
}

async function findListeningPorts() {
  const ports = [];
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileP("netstat", ["-ano", "-p", "TCP"], {
        windowsHide: true,
        timeout: 4000,
        maxBuffer: 4 * 1024 * 1024
      });
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+([^\s:]+(?:\[[^\]]+\])?):(\d+)\s+\S+\s+LISTENING/i);
        if (!m) continue;
        const host = m[1].replace(/^\[|\]$/g, "");
        if (host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "::") {
          ports.push(parseInt(m[2], 10));
        }
      }
    } catch {}
  } else {
    try {
      const { stdout } = await execFileP("ss", ["-ltn"], { timeout: 4000, maxBuffer: 1024 * 1024 });
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(/LISTEN\b.*?:(\d+)\s*$/);
        if (m && /(127\.0\.0\.|\[::1\]|\*:|0\.0\.0\.0:)/.test(line)) {
          ports.push(parseInt(m[1], 10));
        }
      }
    } catch {}
  }
  if (ports.length === 0) {
    const results = await Promise.all(COMMON_DEV_PORTS.map((p) => probePort(p).then((ok) => (ok ? p : 0))));
    for (const p of results) if (p) ports.push(p);
  }
  return [...new Set(ports)].sort((a, b) => a - b);
}

async function handlePortsRoute(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET" });
    res.end();
    return;
  }
  if (!isLoopback(req)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  const now = Date.now();
  if (portsCache.value !== null && now - portsCache.at < 1500) {
    sendJson(res, 200, { ports: portsCache.value });
    return;
  }
  try {
    const found = await findListeningPorts();
    // 预览只关心开发端口：过滤系统低端口，常见开发端口若在监听则保留。
    const dev = found.filter((p) => p >= 1024 || COMMON_DEV_PORTS.includes(p));
    portsCache = { at: Date.now(), value: dev };
    sendJson(res, 200, { ports: dev });
  } catch (err) {
    sendJson(res, 500, { error: String((err && err.message) || err) });
  }
}

// ---------------------------------------------------------------------------
// 在线检查：GET /api/dsh-files/check?url=http://127.0.0.1:3000/
// ---------------------------------------------------------------------------

async function handleCheckRoute(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET" });
    res.end();
    return;
  }
  if (!isLoopback(req)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  let url;
  try {
    url = new URL(req.url, "http://127.0.0.1");
  } catch {
    sendJson(res, 400, { error: "bad request URL" });
    return;
  }
  const targetStr = (url.searchParams.get("url") || "").trim();
  let target;
  try {
    target = new URL(targetStr);
  } catch {
    sendJson(res, 400, { error: "invalid url" });
    return;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    sendJson(res, 400, { error: "only http(s) targets" });
    return;
  }
  const host = target.hostname.replace(/^\[|\]$/g, "");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    sendJson(res, 400, { error: "only loopback targets" });
    return;
  }
  try {
    const r = await fetch(target, { signal: AbortSignal.timeout(2500), redirect: "manual" });
    sendJson(res, 200, { ok: true, status: r.status });
  } catch (err) {
    const cause = err && err.cause && err.cause.code ? err.cause.code : "";
    sendJson(res, 200, { ok: false, error: cause || String((err && err.message) || err) });
  }
}

// ---------------------------------------------------------------------------
// 会话 cwd 查询：GET /api/dsh-files/session-cwd?sessionId=...
// 客户端视图（文件树 / 终端）用它确定项目根目录——不依赖页面内部 hooks。
// 数据源与会话监视器一致：<DSH_HOME>/sessions/**/session.jsonl.zstd 的文件头。
// ---------------------------------------------------------------------------

const ZSTD_MAGIC = 4247762216;

function scanFirstZstdFrame(buffer) {
  let offset = 0;
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) return null;
  offset += 4;
  if (offset === buffer.length) return null;
  const descriptor = buffer.readUInt8(offset++);
  if ((descriptor & 24) !== 0) return null;
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 32) !== 0;
  const checksum = (descriptor & 4) !== 0;
  const dictionaryFlag = descriptor & 3;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  if (buffer.length - offset < remainingHeaderBytes) return null;
  offset += remainingHeaderBytes;
  for (;;) {
    if (buffer.length - offset < 3) return null;
    const blockHeader = buffer.readUIntLE(offset, 3);
    offset += 3;
    const lastBlock = (blockHeader & 1) !== 0;
    const blockType = (blockHeader >>> 1) & 3;
    const blockSize = blockHeader >>> 3;
    if (blockType === 3) return null;
    const payloadBytes = blockType === 1 ? 1 : blockSize;
    if (buffer.length - offset < payloadBytes) return null;
    offset += payloadBytes;
    if (lastBlock) break;
  }
  if (checksum) offset += 4;
  return { start: 0, end: offset };
}

const sessionCwdCache = new Map(); // sessionId -> cwd（会话 cwd 基本不迁移）

function dshSessionsRoot() {
  return join(process.env.DSH_HOME || join(homedir(), ".dsh"), "sessions");
}

function findSessionCwd(sessionId) {
  if (!sessionId) return "";
  if (sessionCwdCache.has(sessionId)) return sessionCwdCache.get(sessionId);
  let cwd = "";
  try {
    const walk = (dir) => {
      if (cwd) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (cwd) return;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "session.jsonl.zstd") {
          try {
            const buf = readFileSync(p);
            const frame = scanFirstZstdFrame(buf);
            if (!frame) return;
            const text = zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString("utf8");
            const header = JSON.parse(text.split("\n", 1)[0]);
            if (header && header.id === sessionId) cwd = String(header.cwd || "");
          } catch {}
        }
      }
    };
    walk(dshSessionsRoot());
  } catch {}
  sessionCwdCache.set(sessionId, cwd);
  return cwd;
}

async function handleSessionCwdRoute(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET" });
    res.end();
    return;
  }
  if (!isLoopback(req)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  let url;
  try {
    url = new URL(req.url, "http://127.0.0.1");
  } catch {
    sendJson(res, 400, { error: "bad request URL" });
    return;
  }
  const sessionId = (url.searchParams.get("sessionId") || "").trim();
  if (!sessionId) {
    sendJson(res, 400, { error: "sessionId is required" });
    return;
  }
  sendJson(res, 200, { sessionId, cwd: findSessionCwd(sessionId) });
}

// ---------------------------------------------------------------------------
// IDE 文件能力：三栏布局使用的只读查看、编辑、Git 状态和文件操作。
// 所有路径必须落在 workspaceRegistry 已登记的工作区中；写请求还要求
// application/json，并拒绝显式跨源 Origin，避免网页对本机服务做 CSRF。
// ---------------------------------------------------------------------------

const IDE_PREFIX = "/vscode-files";
const IDE_READ_LIMIT = 2 * 1024 * 1024;
const IDE_WRITE_LIMIT = 10 * 1024 * 1024;
const IDE_HIGHLIGHT_LIMIT = 1024 * 1024;
const IDE_SEARCH_DEPTH = 8;
const IDE_SEARCH_ENTRIES = 20000;
const IDE_SEARCH_RESULTS = 200;
const IDE_COLLAPSED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", ".next", ".dsh"]);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isHiddenEntry(name) {
  return name.startsWith(".") || IDE_COLLAPSED_DIRS.has(name);
}

function readJsonBody(req, cap = 12 * 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > cap) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return rejectBody(httpError(413, "request body too large"));
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        rejectBody(httpError(400, "invalid JSON body"));
      }
    });
    req.on("error", rejectBody);
  });
}

async function registeredWorkspaceRoot(ctx, input) {
  if (typeof input !== "string" || !isAbsolute(input)) throw httpError(400, "root must be an absolute path");
  const canonical = await realpath(input);
  let allowed = false;
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (typeof workspace?.path !== "string") continue;
    try {
      if (pathKey(await realpath(workspace.path)) === pathKey(canonical)) {
        allowed = true;
        break;
      }
    } catch { /* stale workspace registration */ }
  }
  if (!allowed) throw httpError(403, "folder is not a registered DSH workspace");
  return canonical;
}

async function existingWorkspaceTarget(root, input) {
  if (typeof input !== "string" || !isAbsolute(input)) throw httpError(400, "path must be an absolute path");
  const canonical = await realpath(input);
  if (!isPathInside(root, canonical)) throw httpError(403, "path escapes the workspace");
  return canonical;
}

async function newWorkspaceTarget(root, parentInput, name) {
  if (!validSegment(name)) throw httpError(400, "name must be one path segment (1-120 characters)");
  const parent = await existingWorkspaceTarget(root, parentInput);
  if (!(await stat(parent)).isDirectory()) throw httpError(400, "parent is not a directory");
  const target = resolve(parent, name);
  if (!isPathInside(root, target) || target === root) throw httpError(403, "path escapes the workspace");
  return target;
}

async function readFilePrefix(path, size) {
  const length = Math.min(size, IDE_READ_LIMIT);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function looksBinary(buffer) {
  const n = Math.min(buffer.length, 8192);
  if (n === 0) return false;
  let nul = 0;
  for (let i = 0; i < n; i++) if (buffer[i] === 0) nul++;
  return nul / n > 0.01;
}

function revisionOf(info) {
  return `${info.size}:${Math.trunc(info.mtimeMs)}`;
}

async function gitStatusOf(root) {
  try {
    const { stdout } = await execFileP("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024
    });
    const statuses = {};
    const records = String(stdout).split("\0");
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.length < 4) continue;
      const code = record.slice(0, 2).trim() || "??";
      const file = record.slice(3);
      if (file) statuses[file.replace(/\\/g, "/")] = code;
      // In -z format a rename/copy record is followed by the old path. The
      // first path is the destination, which is what the current tree renders.
      if (code.includes("R") || code.includes("C")) i++;
    }
    return { ok: true, statuses };
  } catch {
    return { ok: false, notRepo: true, error: "not a git repository" };
  }
}

async function searchWorkspace(root, query) {
  const needle = query.toLowerCase();
  const results = [];
  let visited = 0;
  async function walk(dir, depth) {
    if (depth > IDE_SEARCH_DEPTH || visited >= IDE_SEARCH_ENTRIES || results.length >= IDE_SEARCH_RESULTS) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (visited++ >= IDE_SEARCH_ENTRIES || results.length >= IDE_SEARCH_RESULTS) return;
      if (isHiddenEntry(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().includes(needle)) {
        results.push({ name: entry.name, path: full, rel: relative(root, full).split(sep).join("/") });
      }
    }
  }
  await walk(root, 0);
  return results;
}

const IDE_LANGS = {
  js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx", mjs: "javascript", cjs: "javascript",
  html: "html", htm: "html", xml: "xml", svg: "xml", vue: "vue", css: "css", scss: "scss", less: "less",
  json: "json", jsonc: "jsonc", yml: "yaml", yaml: "yaml", md: "markdown", py: "python", sh: "shellscript",
  bash: "shellscript", zsh: "shellscript", go: "go", rs: "rust", java: "java", c: "c", h: "c", cpp: "cpp",
  hpp: "cpp", sql: "sql", toml: "toml", ini: "ini"
};
let shikiPromise;
function loadShiki() {
  shikiPromise ||= import("shiki");
  return shikiPromise;
}

function recycleWorkspaceEntry(target, isDirectory) {
  if (process.platform === "win32") {
    const script = isDirectory
      ? 'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:DSH_DELETE_PATH, "OnlyErrorDialogs", "SendToRecycleBin")'
      : 'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:DSH_DELETE_PATH, "OnlyErrorDialogs", "SendToRecycleBin")';
    return execFileP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, DSH_DELETE_PATH: target },
      windowsHide: true,
      timeout: 60000
    });
  }
  if (process.platform === "darwin") {
    // Pass the path as argv instead of interpolating it into AppleScript, so
    // quotes and other filename characters cannot become script source.
    return execFileP("osascript", [
      "-e", "on run argv",
      "-e", 'tell application "Finder" to delete POSIX file (item 1 of argv)',
      "-e", "end run",
      target
    ], { timeout: 60000, maxBuffer: 1024 * 1024 });
  }
  if (process.platform === "linux") {
    return execFileP("gio", ["trash", "--", target], { timeout: 60000, maxBuffer: 1024 * 1024 });
  }
  throw httpError(501, "moving files to the recycle bin is unsupported on this platform");
}

function ideErrorStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  if (["ENOENT", "ENOTDIR"].includes(error?.code)) return 404;
  if (["EEXIST", "ENOTEMPTY"].includes(error?.code)) return 409;
  if (["EACCES", "EPERM"].includes(error?.code)) return 403;
  return 500;
}

// ---------------------------------------------------------------------------
// 设置页管理：Skill 只管理 <DSH_HOME>/skills 的顶层条目；MCP 直接读写
// profiles/web/cordis.patch.yml 中 @deepseek-ai/dsh-mcp-client 的 loader 行。
// 不创建第二套 mcp-servers.json，避免运行配置分叉。
// ---------------------------------------------------------------------------

function dshHomeRoot() {
  return resolve(process.env.DSH_HOME || join(homedir(), ".dsh"));
}

function globalSkillsRoot() {
  return join(dshHomeRoot(), "skills");
}

function webPatchFile() {
  return join(dshHomeRoot(), "profiles", "web", "cordis.patch.yml");
}

async function regularFile(path) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function listManagedSkills() {
  const root = globalSkillsRoot();
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const skills = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !validSegment(entry.name)) continue;
    const target = join(root, entry.name);
    if (entry.isDirectory()) {
      const enabled = await regularFile(join(target, "SKILL.md"));
      const disabled = await regularFile(join(target, "SKILL.md.disabled"));
      if (!enabled && !disabled) continue;
      skills.push({ id: entry.name, name: entry.name, kind: "dir", enabled, location: `skills/${entry.name}` });
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".md.disabled")) {
      skills.push({ id: entry.name, name: entry.name.slice(0, -".disabled".length), kind: "file", enabled: false, location: `skills/${entry.name}` });
    } else if (entry.name.endsWith(".md")) {
      skills.push({ id: entry.name, name: entry.name, kind: "file", enabled: true, location: `skills/${entry.name}` });
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return skills;
}

async function managedSkillTarget(id) {
  if (!validSegment(id)) throw httpError(400, "invalid Skill id");
  const root = globalSkillsRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, id);
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw httpError(403, "symbolic-link Skills cannot be managed here");
  const canonicalRoot = await realpath(root);
  const canonicalTarget = await realpath(target);
  if (!isPathInside(canonicalRoot, canonicalTarget) || pathKey(canonicalRoot) === pathKey(canonicalTarget)) {
    throw httpError(403, "Skill path escapes DSH_HOME/skills");
  }
  return { target: canonicalTarget, info };
}

async function toggleManagedSkill(id) {
  const { target, info } = await managedSkillTarget(id);
  if (info.isDirectory()) {
    const on = join(target, "SKILL.md");
    const off = join(target, "SKILL.md.disabled");
    if (await regularFile(on)) {
      if (await regularFile(off)) throw httpError(409, "both SKILL.md and SKILL.md.disabled exist");
      await rename(on, off);
      return false;
    }
    if (await regularFile(off)) {
      await rename(off, on);
      return true;
    }
    throw httpError(400, "Skill directory has no manageable SKILL.md");
  }
  if (!info.isFile()) throw httpError(400, "Skill must be a file or directory");
  if (target.endsWith(".md.disabled")) {
    const next = target.slice(0, -".disabled".length);
    try { await lstat(next); throw httpError(409, "enabled Skill file already exists"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    await rename(target, next);
    return true;
  }
  if (!target.endsWith(".md")) throw httpError(400, "unsupported Skill file name");
  const next = target + ".disabled";
  try { await lstat(next); throw httpError(409, "disabled Skill file already exists"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  await rename(target, next);
  return false;
}

async function deleteManagedSkill(id) {
  const { target, info } = await managedSkillTarget(id);
  await recycleWorkspaceEntry(target, info.isDirectory());
}

async function readWebPatch() {
  try { return await readFile(webPatchFile(), "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function mutateWebPatch(operation) {
  const file = webPatchFile();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  return withFileLock(file, async () => {
    let before = "";
    try { before = await readFile(file, "utf8"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    const result = operation(before);
    if (typeof result?.patch !== "string") throw httpError(500, "MCP patch operation returned no content");
    if (result.patch !== before) await writeFileAtomic(file, result.patch, { mode: 0o600, dirMode: 0o700 });
    return result;
  });
}

function managementError(error) {
  if (Number.isInteger(error?.status)) return error;
  const message = String(error?.message || error);
  if (/not found/i.test(message)) return httpError(404, message);
  if (/already exists|duplicate/i.test(message)) return httpError(409, message);
  return httpError(400, message);
}

async function handleIdeRoute(ctx, req, res) {
  if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: "forbidden" });
  let url;
  try { url = new URL(req.url, "http://127.0.0.1"); }
  catch { return sendJson(res, 400, { ok: false, error: "bad request URL" }); }
  try {
    if (req.method === "GET") {
      if (url.pathname === IDE_PREFIX + "/skills") {
        return sendJson(res, 200, { ok: true, root: "DSH_HOME/skills", skills: await listManagedSkills() });
      }
      if (url.pathname === IDE_PREFIX + "/skills/market") {
        const market = await listSkillMarket({ dshHome: dshHomeRoot(), refresh: url.searchParams.get("refresh") === "1" });
        return sendJson(res, 200, { ok: true, ...market });
      }
      if (url.pathname === IDE_PREFIX + "/mcp") {
        return sendJson(res, 200, { ok: true, source: "profiles/web/cordis.patch.yml", servers: listMcpEntries(await readWebPatch()) });
      }
      if (url.pathname === IDE_PREFIX + "/mcp/market") {
        const market = await listMcpMarket({
          dshHome: dshHomeRoot(),
          refresh: url.searchParams.get("refresh") === "1",
          query: url.searchParams.get("q") || "",
        });
        return sendJson(res, 200, { ok: true, ...market });
      }
      if (url.pathname === IDE_PREFIX + "/models/profiles") {
        const current = ctx.agentDefaultModel.currentSelection();
        const profiles = await readModelProfiles(dshHomeRoot());
        const catalog = await listModelCatalog(ctx);
        return sendJson(res, 200, {
          ok: true,
          current,
          profiles: profiles.map((profile) => ({ ...profile, active: sameSelection(profile, current) })),
          ...catalog,
          running: runningAgents(ctx).length,
        });
      }
      if (url.pathname === IDE_PREFIX + "/models/providers") {
        const catalog = await listModelCatalog(ctx);
        return sendJson(res, 200, {
          ok: true,
          current: ctx.agentDefaultModel.currentSelection(),
          ...catalog,
          running: runningAgents(ctx).length,
        });
      }
      const root = await registeredWorkspaceRoot(ctx, url.searchParams.get("root") || "");
      const target = await existingWorkspaceTarget(root, url.searchParams.get("path") || "");
      if (url.pathname === IDE_PREFIX + "/list") {
        if (!(await stat(target)).isDirectory()) throw httpError(400, "path is not a directory");
        const entries = await readdir(target, { withFileTypes: true });
        const dirs = [];
        const files = [];
        for (const entry of entries) {
          const full = join(target, entry.name);
          const hidden = isHiddenEntry(entry.name);
          if (entry.isDirectory()) dirs.push({ name: entry.name, path: full, hidden });
          else if (entry.isFile()) {
            let info;
            try { info = await stat(full); } catch { continue; }
            files.push({ name: entry.name, path: full, size: info.size, mtimeMs: info.mtimeMs, hidden });
          }
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name));
        files.sort((a, b) => a.name.localeCompare(b.name));
        return sendJson(res, 200, { ok: true, path: target, dirs, files });
      }
      if (url.pathname === IDE_PREFIX + "/read") {
        const before = await stat(target);
        if (!before.isFile()) throw httpError(400, "path is not a file");
        const buffer = await readFilePrefix(target, before.size);
        const after = await stat(target);
        if (revisionOf(before) !== revisionOf(after)) throw httpError(409, "file changed while reading; retry");
        if (looksBinary(buffer)) return sendJson(res, 200, { ok: true, kind: "binary", content: "", size: after.size, revision: revisionOf(after) });
        return sendJson(res, 200, {
          ok: true,
          kind: after.size > IDE_READ_LIMIT ? "too-large" : "text",
          content: buffer.toString("utf8"),
          size: after.size,
          revision: revisionOf(after)
        });
      }
      if (url.pathname === IDE_PREFIX + "/git") return sendJson(res, 200, await gitStatusOf(root));
      if (url.pathname === IDE_PREFIX + "/search") {
        const query = String(url.searchParams.get("q") || "").trim();
        if (!query) throw httpError(400, "missing q");
        return sendJson(res, 200, { ok: true, results: await searchWorkspace(root, query) });
      }
      if (url.pathname === IDE_PREFIX + "/highlight") {
        const info = await stat(target);
        if (!info.isFile()) throw httpError(400, "path is not a file");
        if (info.size > IDE_HIGHLIGHT_LIMIT) return sendJson(res, 200, { ok: false, error: "too large to highlight" });
        const buffer = await readFilePrefix(target, info.size);
        if (looksBinary(buffer)) return sendJson(res, 200, { ok: false, error: "binary" });
        const shiki = await loadShiki();
        const extension = extname(target).slice(1).toLowerCase();
        const html = await shiki.codeToHtml(buffer.toString("utf8"), {
          lang: IDE_LANGS[extension] || "text",
          theme: url.searchParams.get("theme") === "light" ? "github-light" : "github-dark"
        });
        return sendJson(res, 200, { ok: true, html });
      }
      throw httpError(404, "unknown vscode-files endpoint");
    }

    if (req.method !== "POST") throw httpError(405, "method not allowed");
    if (!sameOriginMutation(req)) throw httpError(403, "same-origin application/json request required");
    const managementRoute = url.pathname.startsWith(IDE_PREFIX + "/skills/") || url.pathname.startsWith(IDE_PREFIX + "/mcp/") || url.pathname.startsWith(IDE_PREFIX + "/models/");
    const body = await readJsonBody(req, managementRoute ? 256 * 1024 : 12 * 1024 * 1024);
    if (url.pathname === IDE_PREFIX + "/skills/toggle") {
      const enabled = await toggleManagedSkill(body?.id);
      return sendJson(res, 200, { ok: true, enabled });
    }
    if (url.pathname === IDE_PREFIX + "/skills/delete") {
      await deleteManagedSkill(body?.id);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === IDE_PREFIX + "/skills/market/preview") {
      const preview = await previewMarketSkill({ dshHome: dshHomeRoot(), source: body?.source, skillId: body?.skillId });
      return sendJson(res, 200, { ok: true, preview });
    }
    if (url.pathname === IDE_PREFIX + "/skills/market/install") {
      const installed = await installMarketSkill({ dshHome: dshHomeRoot(), source: body?.source, skillId: body?.skillId });
      return sendJson(res, 200, { ok: true, installed });
    }
    if (url.pathname === IDE_PREFIX + "/skills/market/config") {
      const config = await saveMarketConfig(dshHomeRoot(), body);
      return sendJson(res, 200, { ok: true, config });
    }
    if (url.pathname === IDE_PREFIX + "/mcp/toggle") {
      try {
        const result = await mutateWebPatch((patch) => toggleMcpEntry(patch, body?.id));
        return sendJson(res, 200, { ok: true, enabled: result.enabled, restartRequired: true });
      } catch (error) { throw managementError(error); }
    }
    if (url.pathname === IDE_PREFIX + "/mcp/delete") {
      try {
        await mutateWebPatch((patch) => ({ patch: deleteMcpEntry(patch, body?.id) }));
        return sendJson(res, 200, { ok: true, restartRequired: true });
      } catch (error) { throw managementError(error); }
    }
    if (url.pathname === IDE_PREFIX + "/mcp/add") {
      try {
        const result = await mutateWebPatch((patch) => addMcpEntry(patch, body));
        return sendJson(res, 200, { ok: true, entry: result.entry, restartRequired: true });
      } catch (error) { throw managementError(error); }
    }
    if (url.pathname === IDE_PREFIX + "/mcp/market/config") {
      const config = await saveMcpMarketConfig(dshHomeRoot(), body);
      return sendJson(res, 200, { ok: true, config });
    }
    if (url.pathname === IDE_PREFIX + "/mcp/market/install") {
      const prepared = await prepareMcpMarketInstall(dshHomeRoot(), body);
      try {
        const result = await mutateWebPatch((patch) => addMcpEntry(patch, prepared.config));
        return sendJson(res, 200, { ok: true, entry: result.entry, market: prepared.entry, restartRequired: true, enabled: false });
      } catch (error) { throw managementError(error); }
    }
    if (url.pathname === IDE_PREFIX + "/models/profiles/save") {
      const selection = {
        provider: body?.provider,
        model: body?.model,
        ...(body?.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
      };
      try { await ctx.llm.resolveCallConfig(selection); }
      catch (error) { throw httpError(400, `模型配置不可用：${String(error?.message || error)}`); }
      const profile = await saveModelProfile(dshHomeRoot(), body);
      return sendJson(res, 200, { ok: true, profile });
    }
    if (url.pathname === IDE_PREFIX + "/models/profiles/delete") {
      await deleteModelProfile(dshHomeRoot(), body?.id);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === IDE_PREFIX + "/models/profiles/switch") {
      const switched = await switchModelProfile(ctx, dshHomeRoot(), body?.id);
      return sendJson(res, 200, { ok: true, ...switched });
    }
    if (url.pathname === IDE_PREFIX + "/models/providers/switch") {
      const switched = await switchModelProvider(ctx, body?.provider);
      return sendJson(res, 200, { ok: true, ...switched });
    }
    const root = await registeredWorkspaceRoot(ctx, body?.root);
    if (url.pathname === IDE_PREFIX + "/write") {
      if (typeof body?.content !== "string") throw httpError(400, "body needs { root, path, content }");
      if (Buffer.byteLength(body.content, "utf8") > IDE_WRITE_LIMIT) throw httpError(413, "content too large");
      const target = await existingWorkspaceTarget(root, body.path);
      let saved;
      await withFileLock(target, async () => {
        const info = await stat(target);
        if (!info.isFile()) throw httpError(400, "path is not a file");
        if (typeof body.expectedRevision === "string" && body.expectedRevision !== revisionOf(info)) {
          throw httpError(409, "file changed on disk; reload it before saving");
        }
        await writeFileAtomic(target, body.content, { mode: info.mode & 0o777 });
        saved = await stat(target);
      });
      return sendJson(res, 200, { ok: true, size: saved.size, revision: revisionOf(saved) });
    }
    if (url.pathname === IDE_PREFIX + "/mkdir" || url.pathname === IDE_PREFIX + "/mkfile") {
      const target = await newWorkspaceTarget(root, body?.path, body?.name);
      if (url.pathname.endsWith("/mkdir")) await mkdir(target);
      else await writeFile(target, "", { flag: "wx", mode: 0o644 });
      return sendJson(res, 200, { ok: true, path: target });
    }
    if (url.pathname === IDE_PREFIX + "/rename") {
      const source = await existingWorkspaceTarget(root, body?.path);
      if (pathKey(source) === pathKey(root)) throw httpError(403, "cannot rename the workspace root");
      const target = await newWorkspaceTarget(root, dirname(source), body?.newName);
      try {
        await stat(target);
        throw httpError(409, "a file or folder with that name already exists");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await rename(source, target);
      return sendJson(res, 200, { ok: true, path: target });
    }
    if (url.pathname === IDE_PREFIX + "/delete") {
      const target = await existingWorkspaceTarget(root, body?.path);
      if (pathKey(target) === pathKey(root)) throw httpError(403, "cannot delete the workspace root");
      const info = await stat(target);
      await recycleWorkspaceEntry(target, info.isDirectory());
      return sendJson(res, 200, { ok: true });
    }
    throw httpError(404, "unknown vscode-files endpoint");
  } catch (error) {
    return sendJson(res, ideErrorStatus(error), { ok: false, error: String(error?.message || error) });
  }
}

const name = "dsh-file-changes";
const inject = ["sessionProjections", "webServer", "workspaceRegistry", "llm", "agents", "agentDefaultModel"];

function apply(ctx) {
  ctx.sessionProjections.register(fileChangesProjectionDefinition);
  const disposers = [
    ctx.webServer.register({ kind: "exact", path: LIST_ROUTE, handler: handleListRoute }),
    ctx.webServer.register({ kind: "exact", path: "/api/dsh-files/ports", handler: handlePortsRoute }),
    ctx.webServer.register({ kind: "exact", path: "/api/dsh-files/check", handler: handleCheckRoute }),
    ctx.webServer.register({ kind: "exact", path: "/api/dsh-files/session-cwd", handler: handleSessionCwdRoute }),
    ctx.webServer.register({ kind: "prefix", path: IDE_PREFIX, handler: (req, res) => handleIdeRoute(ctx, req, res) }),
    // 注意：prefix 不能带尾部斜杠（webserver 按 prefix + "/" 匹配）。
    ctx.webServer.register({ kind: "prefix", path: STATIC_PREFIX.replace(/\/+$/, ""), handler: handleStaticRoute })
  ];
  return () => { for (const d of disposers) d(); };
}

export { apply, inject, isPathInside, name, sameOriginMutation, validSegment };
