const MCP_PACKAGE = "@deepseek-ai/dsh-mcp-client";
const MCP_BEGIN = "# EAC MCP manager BEGIN (managed entries)";
const MCP_END = "# EAC MCP manager END";

function parseScalar(raw) {
  const text = String(raw || "").trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  if (text === "true") return true;
  if (text === "false") return false;
  return text.replace(/\s+#.*$/, "").trim();
}

function fieldOf(lines, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}:\\s*(.*?)\\s*$`);
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) return parseScalar(match[1]);
  }
  return undefined;
}

function childRows(patch) {
  const lines = String(patch || "").split(/\r?\n/);
  const rows = [];
  for (let blockStart = 0; blockStart < lines.length; blockStart++) {
    if (!/^-\s*insert:\s*$/.test(lines[blockStart])) continue;
    let blockEnd = blockStart + 1;
    while (blockEnd < lines.length && !/^-\s/.test(lines[blockEnd]) && !/^#\s/.test(lines[blockEnd])) blockEnd++;
    for (let rowStart = blockStart + 1; rowStart < blockEnd;) {
      const match = /^(\s+)- id:\s*(.*?)\s*$/.exec(lines[rowStart]);
      if (!match) {
        rowStart++;
        continue;
      }
      const indent = match[1].length;
      let rowEnd = rowStart + 1;
      while (rowEnd < blockEnd) {
        const sibling = /^(\s+)- id:\s*/.exec(lines[rowEnd]);
        if (sibling && sibling[1].length <= indent) break;
        rowEnd++;
      }
      const rowLines = lines.slice(rowStart, rowEnd);
      rows.push({
        id: String(parseScalar(match[2])),
        name: fieldOf(rowLines, "name"),
        blockStart,
        blockEnd,
        rowStart,
        rowEnd,
        indent,
        lines: rowLines,
      });
      rowStart = rowEnd;
    }
    blockStart = blockEnd - 1;
  }
  return { lines, rows };
}

function mcpRows(patch) {
  const parsed = childRows(patch);
  return {
    ...parsed,
    rows: parsed.rows.filter((row) => row.name === MCP_PACKAGE),
  };
}

function publicMcp(row) {
  const transport = fieldOf(row.lines, "transport") === "streamable-http" ? "streamable-http" : "stdio";
  const serverName = String(fieldOf(row.lines, "serverName") || row.id.replace(/^mcp-/, ""));
  let marketPackage = "";
  if (transport === "stdio") {
    const rawArgs = String(fieldOf(row.lines, "args") || "");
    try {
      const args = JSON.parse(rawArgs);
      const candidate = Array.isArray(args) ? args.find((arg) => /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+@[^@]+$/.test(String(arg))) : undefined;
      if (candidate) {
        const value = String(candidate);
        const versionAt = value.lastIndexOf("@");
        marketPackage = versionAt > 0 ? value.slice(0, versionAt) : value;
      }
    } catch {}
  }
  return {
    id: row.id,
    serverName,
    transport,
    command: transport === "stdio" ? String(fieldOf(row.lines, "command") || "") : "",
    url: transport === "streamable-http" ? String(fieldOf(row.lines, "url") || "") : "",
    enabled: fieldOf(row.lines, "disabled") !== true,
    hasEnv: row.lines.some((line) => /^\s*(env|headers):\s*/.test(line)),
    marketPackage,
  };
}

function listMcpEntries(patch) {
  return mcpRows(patch).rows.map(publicMcp);
}

function requireSingleMcp(patch, id) {
  if (typeof id !== "string" || !/^mcp-[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("invalid MCP id");
  const parsed = mcpRows(patch);
  const matches = parsed.rows.filter((row) => row.id === id);
  if (matches.length === 0) throw new Error("MCP server not found");
  if (matches.length !== 1) throw new Error("duplicate MCP id; resolve it in cordis.patch.yml first");
  return { ...parsed, row: matches[0] };
}

function toggleMcpEntry(patch, id) {
  const parsed = requireSingleMcp(patch, id);
  const enabled = publicMcp(parsed.row).enabled;
  const lines = [...parsed.lines];
  let disabledAt = -1;
  for (let i = parsed.row.rowStart + 1; i < parsed.row.rowEnd; i++) {
    if (/^\s*disabled:\s*/.test(lines[i])) {
      disabledAt = i;
      break;
    }
  }
  const nextValue = enabled ? "true" : "false";
  if (disabledAt !== -1) lines[disabledAt] = lines[disabledAt].replace(/disabled:\s*\S+\s*$/, `disabled: ${nextValue}`);
  else lines.splice(parsed.row.rowStart + 1, 0, `${" ".repeat(parsed.row.indent + 2)}disabled: ${nextValue}`);
  return { patch: lines.join("\n"), enabled: !enabled };
}

function deleteMcpEntry(patch, id) {
  const parsed = requireSingleMcp(patch, id);
  const siblingCount = parsed.rows.filter((row) => row.blockStart === parsed.row.blockStart).length;
  const allSiblingCount = childRows(patch).rows.filter((row) => row.blockStart === parsed.row.blockStart).length;
  const lines = [...parsed.lines];
  if (siblingCount === 1 && allSiblingCount === 1) lines.splice(parsed.row.blockStart, parsed.row.blockEnd - parsed.row.blockStart);
  else lines.splice(parsed.row.rowStart, parsed.row.rowEnd - parsed.row.rowStart);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function validateStringMap(value, label) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > 64) throw new Error(`${label} has too many entries`);
  const out = {};
  for (const [key, raw] of entries) {
    if (!key || key.length > 128 || /[\r\n]/.test(key)) throw new Error(`invalid ${label} key`);
    const text = String(raw);
    if (text.length > 8192) throw new Error(`${label} value is too long`);
    out[key] = text;
  }
  return out;
}

function normalizeMcpInput(input) {
  const serverName = typeof input?.serverName === "string" ? input.serverName.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(serverName)) throw new Error("serverName must use 1-64 letters, digits, _ or -");
  const transport = input?.transport === "streamable-http" ? "streamable-http" : "stdio";
  const args = Array.isArray(input?.args) ? input.args.map(String) : [];
  if (args.length > 64 || args.some((arg) => arg.length > 4096 || /[\r\n]/.test(arg))) throw new Error("invalid MCP arguments");
  const env = validateStringMap(input?.env, "env");
  const headers = validateStringMap(input?.headers, "headers");
  if (transport === "stdio") {
    const command = typeof input?.command === "string" ? input.command.trim() : "";
    if (!command || command.length > 4096 || /[\r\n]/.test(command)) throw new Error("stdio MCP needs a valid command");
    return { id: `mcp-${serverName}`, serverName, transport, command, args, env, enabled: input?.enabled !== false };
  }
  const rawUrl = typeof input?.url === "string" ? input.url.trim() : "";
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error("streamable-http MCP needs a valid URL"); }
  if (!/^https?:$/.test(url.protocol) || rawUrl.length > 4096) throw new Error("MCP URL must use http or https");
  return { id: `mcp-${serverName}`, serverName, transport, url: rawUrl, headers, enabled: input?.enabled !== false };
}

function serializeMcpRow(config) {
  const q = (value) => JSON.stringify(value);
  const lines = [
    "- insert:",
    `    - id: ${config.id}`,
    ...(config.enabled ? [] : ["      disabled: true"]),
    `      name: '${MCP_PACKAGE}'`,
    "      config:",
    `        transport: ${config.transport}`,
    `        serverName: ${q(config.serverName)}`,
  ];
  if (config.transport === "stdio") {
    lines.push(`        command: ${q(config.command)}`, `        args: ${q(config.args)}`);
    if (Object.keys(config.env).length) lines.push(`        env: ${q(config.env)}`);
  } else {
    lines.push(`        url: ${q(config.url)}`);
    if (Object.keys(config.headers).length) lines.push(`        headers: ${q(config.headers)}`);
  }
  return lines.join("\n") + "\n";
}

function addMcpEntry(patch, input) {
  const config = normalizeMcpInput(input);
  const parsed = childRows(patch);
  if (parsed.rows.some((row) => row.id === config.id)) throw new Error("MCP id already exists in cordis.patch.yml");
  const row = serializeMcpRow(config);
  let text = String(patch || "");
  if (text.trim() === "[]") text = "";
  const end = text.indexOf(MCP_END);
  if (end !== -1) {
    const before = text.slice(0, end).replace(/\s*$/, "\n");
    return { patch: before + row + text.slice(end), entry: publicMcp(mcpRows(row).rows[0]) };
  }
  text = text.trimEnd();
  const prefix = text ? text + "\n\n" : "";
  const next = prefix + MCP_BEGIN + "\n" + row + MCP_END + "\n";
  return { patch: next, entry: publicMcp(mcpRows(row).rows[0]) };
}

export { MCP_PACKAGE, addMcpEntry, deleteMcpEntry, listMcpEntries, normalizeMcpInput, toggleMcpEntry };
