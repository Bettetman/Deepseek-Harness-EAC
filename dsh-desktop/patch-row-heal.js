'use strict';

// cordis.patch.yml row heal for dsh-soul-md.
//
// v2.0.0 shipped the bundled dsh-soul-md plugin whose config schema declared
// `path` as REQUIRED with no default, while the profile patch row written by
// syncCompanionPlugins carried only id + name (no config). On a fresh install
// config validation then failed for that row, which took down the ENTIRE
// plugin tree: `dsh web` exited with code 1 and the app showed "启动失败"
// (persistent crash loop — the exe re-syncs the row on every boot, so users
// could not delete their way out of it).
//
// The plugin schema now defaults `path` to "soul.md" (missing file → empty
// fallback → NO prompt section → the stock official system prompt is used
// untouched), so a config-less row boots fine again. New rows are also
// written WITH an explicit config block (see configLinesFor below), and this
// heal pass fixes ALREADY-BROKEN rows living in existing user profiles, so
// upgrading to the fixed build repairs them without any manual edit.

/** Serialize a config object as patch-row YAML lines (2-space step from `name:`). */
function configLinesFor(config) {
  let out = '      config:\n';
  for (const [k, v] of Object.entries(config || {})) {
    out += `        ${k}: ${JSON.stringify(v)}\n`;
  }
  return out;
}

/**
 * Ensure every soul-md row in `patch` carries config.path.
 * Idempotent: rows that already have a config block are left untouched.
 * Returns { patch, healed } — healed lists row ids that were modified.
 */
function healSoulMdPatchRow(patch, config = { path: 'soul.md' }) {
  const healed = [];
  if (typeof patch !== 'string' || patch === '') return { patch, healed };
  // A row looks like:
  //   - insert:
  //       - id: soul-md
  //         name: 'dsh-soul-md'
  //         (config: ... optional)
  // Match the `id:` + `name:` lines; only rewrite when the NEXT non-blank
  // line is not a `config:` key (negative lookahead keeps healed rows stable).
  const rowRe = /(^[\t ]*- id: soul-md\b[^\n]*\n[\t ]*name: ['"]?[^'"\n]+['"]?\n)(?![\t ]*config:)/gm;
  let out = patch.replace(rowRe, (m) => m + configLinesFor(config));
  if (out !== patch) healed.push('soul-md');
  return { patch: out, healed };
}

/**
 * Remove insert-blocks for rows the profile already mounts through its
 * package.json bundle list (`dsh.profile.bundles`, written by `dsh plugin
 * add` — i.e. anything the user installed from the plugin market).
 *
 * A bundle listed there is loaded WITH its own packaged cordis.patch.yml,
 * which mounts the row itself. When syncCompanionPlugins has also written an
 * overlay row for the same plugin, the loader aborts the whole tree with
 * `duplicate loader entry id: <id>` (dsh web exits 1 → "启动失败" crash
 * loop). Dropping the overlay copy is safe: the bundle still mounts it.
 *
 * `rowIds` maps row id → package name; only rows whose package name appears
 * in the bundle list are removed. Returns { patch, removed }.
 */
function removeBundledRowDuplicates(patch, rowIds, bundleNames) {
  const removed = [];
  if (typeof patch !== 'string' || patch === '' || !bundleNames.length) return { patch, removed };
  const targets = Object.entries(rowIds)
    .filter(([, pkg]) => bundleNames.includes(pkg))
    .map(([id]) => id);
  if (!targets.length) return { patch, removed };
  const lines = patch.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^-\s*insert:/.test(line)) {
      const m = /\bid:\s*([\w-]+)/.exec(lines[i + 1] || '');
      if (m && targets.includes(m[1])) {
        removed.push(m[1]);
        // Skip the block body: indented non-comment lines up to the next
        // top-level key / block / comment / blank line.
        let j = i + 1;
        while (j < lines.length && !/^-\s*insert:/.test(lines[j]) && /^#/.test(lines[j]) === false && /^\s+\S/.test(lines[j])) j++;
        i = j - 1;
        continue;
      }
    }
    out.push(line);
  }
  // Collapse the blank line an inner removed block may leave behind.
  let text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  if (!text.endsWith('\n')) text += '\n';
  return { patch: text, removed };
}

const IDE_LAYOUT_BEGIN = '# EAC IDE layout BEGIN (managed; do not edit inside)';
const IDE_LAYOUT_END = '# EAC IDE layout END';

/**
 * Remove pre-managed IDE layout rows written by an earlier/manual install.
 * Leaving either row beside the managed block creates a duplicate loader id
 * (or two patches for the stock layout) and aborts the entire web profile.
 */
function removeLegacyIdeLayoutRows(patch) {
  const lines = patch.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    let end = i + 1;
    while (end < lines.length && !/^-\s/.test(lines[end]) && !/^#/.test(lines[end])) end++;
    const block = lines.slice(i, end);
    const legacyDisable = /^-\s*id:\s*ui-layout\b/.test(line)
      && block.some((row) => /^\s+disabled:\s*true\s*$/.test(row));
    if (legacyDisable) {
      i = end;
      continue;
    }
    if (/^-\s*insert:\s*$/.test(line)) {
      const body = block.slice(1);
      const kept = [];
      let removed = false;
      for (let j = 0; j < body.length;) {
        const match = /^(\s*)- id:\s*ide-layout\b/.exec(body[j]);
        if (!match) {
          kept.push(body[j++]);
          continue;
        }
        removed = true;
        const rowIndent = match[1].length;
        j++;
        while (j < body.length) {
          const next = /^(\s*)- id:\s*/.exec(body[j]);
          if (next && next[1].length <= rowIndent) break;
          j++;
        }
      }
      if (removed) {
        // A manually assembled insert block may contain several plugin rows.
        // Remove only ide-layout; never discard unrelated sibling rows.
        if (kept.some((row) => /^\s+- id:\s*/.test(row))) out.push(line, ...kept);
        i = end;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Replace the stock root layout with EAC's bundled IDE root without touching
 * the official installation. The profile overlay disables the stock row and
 * inserts the alternative under a distinct id, so upgrades remain reversible.
 */
function ensureIdeLayoutPatch(patch) {
  const input = typeof patch === 'string' ? patch : '';
  let clean = input;
  const start = clean.indexOf(IDE_LAYOUT_BEGIN);
  if (start !== -1) {
    const end = clean.indexOf(IDE_LAYOUT_END, start + IDE_LAYOUT_BEGIN.length);
    clean = end === -1
      ? clean.slice(0, start)
      : clean.slice(0, start) + clean.slice(end + IDE_LAYOUT_END.length);
  }
  clean = removeLegacyIdeLayoutRows(clean);
  clean = clean.replace(/\n{3,}/g, '\n\n').trimEnd();
  const block = [
    IDE_LAYOUT_BEGIN,
    '- id: ui-layout',
    '  disabled: true',
    '- insert:',
    '    - id: ide-layout',
    "      name: '@anoslide/dsh-client-vscode-layout'",
    IDE_LAYOUT_END,
    ''
  ].join('\n');
  return (clean ? clean + '\n\n' : '') + block;
}

/** Force one inserted profile row disabled without rewriting its other config. */
function ensureInsertRowDisabled(patch, rowId) {
  if (typeof patch !== 'string' || patch === '' || typeof rowId !== 'string' || rowId === '') {
    return { patch, changed: false };
  }
  const escaped = rowId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = patch.split(/\r?\n/);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const match = new RegExp(`^(\\s+)- id:\\s*${escaped}\\b`).exec(lines[i]);
    if (!match) continue;
    const rowIndent = match[1].length;
    let end = i + 1;
    while (end < lines.length) {
      const sibling = /^(\s*)- id:\s*/.exec(lines[end]);
      if (sibling && sibling[1].length <= rowIndent) break;
      if (/^-\s/.test(lines[end]) || /^#/.test(lines[end])) break;
      end++;
    }
    const disabled = lines.slice(i + 1, end).findIndex((line) => {
      const m = /^(\s*)disabled:\s*/.exec(line);
      return m && m[1].length > rowIndent;
    });
    if (disabled !== -1) {
      const at = i + 1 + disabled;
      const next = lines[at].replace(/disabled:\s*\S+\s*$/, 'disabled: true');
      if (next !== lines[at]) {
        lines[at] = next;
        changed = true;
      }
    } else {
      lines.splice(i + 1, 0, `${' '.repeat(rowIndent + 2)}disabled: true`);
      changed = true;
    }
  }
  return { patch: lines.join('\n'), changed };
}

module.exports = { configLinesFor, ensureIdeLayoutPatch, ensureInsertRowDisabled, healSoulMdPatchRow, removeBundledRowDuplicates };
