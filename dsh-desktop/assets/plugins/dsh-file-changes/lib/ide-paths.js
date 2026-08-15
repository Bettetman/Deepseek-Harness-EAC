import { isAbsolute, relative, sep } from "node:path";

function pathKey(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** True when candidate is root itself or a descendant, never a prefix sibling. */
function isPathInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

function validSegment(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 120
    && value !== "." && value !== ".."
    && !/[\\/\0-\x1f<>:"|?*]/.test(value)
    && !/[. ]$/.test(value)
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value);
}

/**
 * Browser writes must be JSON and same-origin. Requests without Origin are
 * retained for the local CLI/test path; browsers attach Origin cross-site.
 */
function sameOriginMutation(req) {
  const type = String(req.headers["content-type"] || "").toLowerCase();
  if (!type.startsWith("application/json")) return false;
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.host === String(req.headers.host || "");
  } catch {
    return false;
  }
}

export { isPathInside, pathKey, sameOriginMutation, validSegment };
