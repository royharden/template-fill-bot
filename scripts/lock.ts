// `npm run lock` — regenerate supabase/functions/_shared/content/library.lock.ts from the committed content.
// Use ONLY after a deliberate, reviewed change to clauses.ts, frame.ts or jurisdiction.ts (PLAN K17, DV-LOCK).
// Refuses to write when the content fails static validation. Prints a diff summary against the previous lock.
//   npm run lock            write the lock
//   npm run lock -- --check compare only; exit 1 when the committed lock is missing, UNLOCKED or stale
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LIBRARY_CONTENT, computeLock, validateContent, verifyLibrary } from '../supabase/functions/_shared/fillkit/library.ts';
import { LIBRARY_LOCK } from '../supabase/functions/_shared/content/library.lock.ts';
import type { LibraryLock, LockedLibraryLock } from '../supabase/functions/_shared/content/types.ts';

const LOCK_PATH = fileURLToPath(new URL('../supabase/functions/_shared/content/library.lock.ts', import.meta.url));

function renderMap(map: Readonly<Record<string, string>>): string {
  const lines = Object.keys(map)
    .sort()
    .map((id) => `    ${JSON.stringify(id)}: ${JSON.stringify(map[id])},`);
  return `{\n${lines.join('\n')}\n  }`;
}

function renderLockModule(lock: LockedLibraryLock): string {
  return [
    '// GENERATED FILE: written only by `npm run lock` (scripts/lock.ts). Do not edit by hand.',
    '// Regenerate only after a deliberate, reviewed change to clauses.ts, frame.ts or jurisdiction.ts.',
    "import type { LibraryLock } from './types.ts';",
    '',
    'export const LIBRARY_LOCK: LibraryLock = {',
    "  status: 'LOCKED',",
    `  version: ${lock.version},`,
    `  clauses: ${renderMap(lock.clauses)},`,
    `  frame: ${renderMap(lock.frame)},`,
    `  jurisdiction: ${JSON.stringify(lock.jurisdiction)},`,
    `  overall: ${JSON.stringify(lock.overall)},`,
    '};',
    '',
  ].join('\n');
}

function diffMaps(
  label: string,
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  const lines: string[] = [];
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const id of ids) {
    const was = before[id];
    const now = after[id];
    if (was === undefined) {
      lines.push(`  + ${label} ${id}`);
    } else if (now === undefined) {
      lines.push(`  - ${label} ${id}`);
    } else if (was !== now) {
      lines.push(`  ~ ${label} ${id}`);
    }
  }
  return lines;
}

function diffSummary(previous: LibraryLock, next: LockedLibraryLock): string[] {
  if (previous.status !== 'LOCKED') {
    return [
      `previous lock: UNLOCKED sentinel ("${previous.note}")`,
      `new lock: ${Object.keys(next.clauses).length} clauses, ${Object.keys(next.frame).length} frame records`,
      `overall ${next.overall}`,
    ];
  }
  const lines = [
    ...diffMaps('clause', previous.clauses, next.clauses),
    ...diffMaps('frame', previous.frame, next.frame),
  ];
  if (previous.jurisdiction !== next.jurisdiction) {
    lines.push('  ~ jurisdiction');
  }
  if (previous.overall === next.overall) {
    return ['no change: lock already matches the content'];
  }
  return [`changes (${lines.length}):`, ...lines, `overall ${previous.overall} -> ${next.overall}`];
}

function main(argv: readonly string[]): number {
  const checkOnly = argv.includes('--check');

  const problems = validateContent(LIBRARY_CONTENT);
  if (problems.length > 0) {
    console.error(`lock: content is invalid (${problems.length} problem(s)); lock NOT written:`);
    for (const p of problems) {
      console.error(`  ${p}`);
    }
    return 1;
  }

  const next = computeLock(LIBRARY_CONTENT);

  if (checkOnly) {
    const verification = verifyLibrary(LIBRARY_CONTENT, LIBRARY_LOCK);
    if (verification.ok) {
      console.log(`lock --check: OK (overall ${verification.lock.overall})`);
      return 0;
    }
    console.error('lock --check: FAILED');
    for (const r of verification.reasons) {
      console.error(`  ${r}`);
    }
    return 1;
  }

  const text = renderLockModule(next);
  let existing = '';
  try {
    existing = readFileSync(LOCK_PATH, 'utf8');
  } catch {
    existing = '';
  }
  for (const line of diffSummary(LIBRARY_LOCK, next)) {
    console.log(line);
  }
  if (existing === text) {
    console.log(`lock: ${LOCK_PATH} unchanged`);
    return 0;
  }
  writeFileSync(LOCK_PATH, text, 'utf8');
  console.log(`lock: wrote ${LOCK_PATH}. Review the diff (git diff) before committing.`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
