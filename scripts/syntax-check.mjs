#!/usr/bin/env node
// Dirty-Mode static parse check (PLAN section 6, common static acceptance (i)).
//
//   node scripts/syntax-check.mjs [file ...]
//
// - .ts        : strip types with node:module stripTypeScriptTypes(src, { mode: 'strip' }) (fails on
//                non-erasable TypeScript such as enum / namespace / parameter properties), write the stripped
//                output to a temp .mjs in os.tmpdir(), then `node --check` it in a child process.
// - .json      : JSON.parse.
// - .js / .mjs : `node --check` directly.
// - .tsx       : reported as SKIP (JSX cannot be stripped; checked by reading).
// With no arguments, walks the repo (skipping node_modules, dist, coverage and dot-folders such as .git) for
// .ts, .json, .js and .mjs files.
//
// This script only PARSES. It never imports, resolves or runs project code.
// Exit codes: 0 all passed, 1 at least one failure, 2 stripTypeScriptTypes unavailable ("tool unavailable,
// source inspection only").
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);
const WALK_EXTENSIONS = new Set(['.ts', '.json', '.js', '.mjs']);

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name) && entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && WALK_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function firstLines(text, n) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(0, n)
    .join(' | ');
}

function nodeCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.error) {
    return { ok: false, detail: `could not run node --check: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { ok: false, detail: firstLines(result.stderr, 6) };
  }
  return { ok: true };
}

const stripTypeScriptTypes = nodeModule.stripTypeScriptTypes;
if (typeof stripTypeScriptTypes !== 'function') {
  console.log(
    `syntax-check: tool unavailable, source inspection only (node:module stripTypeScriptTypes is missing in Node ${process.version})`,
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const files = args.length > 0 ? args.map((f) => resolve(f)) : walk(repoRoot, []).sort();

const tempDir = mkdtempSync(join(tmpdir(), 'tfb-syntax-'));
const counts = { ts: 0, json: 0, js: 0, skipped: 0 };
const failures = [];
let passed = 0;

try {
  files.forEach((file, index) => {
    const label = relative(repoRoot, file) || file;
    const ext = extname(file).toLowerCase();
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch (error) {
      failures.push({ label, detail: `cannot read: ${error.message}` });
      return;
    }

    if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
      counts.ts++;
      let stripped;
      try {
        stripped = stripTypeScriptTypes(source, { mode: 'strip' });
      } catch (error) {
        failures.push({ label, detail: `strip failed: ${firstLines(error.message, 4)}` });
        return;
      }
      const tempFile = join(tempDir, `${index}.mjs`);
      writeFileSync(tempFile, stripped, 'utf8');
      const result = nodeCheck(tempFile);
      if (result.ok) passed++;
      else failures.push({ label, detail: result.detail.split(tempFile).join(label) });
    } else if (ext === '.json') {
      counts.json++;
      try {
        JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
        passed++;
      } catch (error) {
        failures.push({ label, detail: `JSON.parse: ${error.message}` });
      }
    } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      counts.js++;
      const result = nodeCheck(file);
      if (result.ok) passed++;
      else failures.push({ label, detail: result.detail });
    } else if (ext === '.tsx') {
      counts.skipped++;
      console.log(`SKIP ${label} (tsx: JSX cannot be type-stripped; checked by reading)`);
    } else {
      counts.skipped++;
      console.log(`SKIP ${label} (unsupported extension ${ext || '(none)'})`);
    }
  });
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

for (const failure of failures) {
  console.log(`FAIL ${failure.label}: ${failure.detail}`);
}
console.log(
  `syntax-check: ${files.length} file(s) (ts ${counts.ts}, json ${counts.json}, js ${counts.js}), ` +
    `${passed} passed, ${failures.length} failed, ${counts.skipped} skipped`,
);
process.exit(failures.length > 0 ? 1 : 0);
