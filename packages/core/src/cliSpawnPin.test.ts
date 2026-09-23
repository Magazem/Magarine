import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Ruling 41 made the REAL adapter the default, so a test that spawns the CLI
// without naming an adapter would launch the owner's real Claude CLI: their
// usage, minutes of runtime. Every `spawnManaged({...})` whose arguments
// contain `cliPath` must therefore pin the adapter -- `pinnedFakeEnv(` (or
// an explicit MAGARINE_ADAPTER / --adapter). This walks every test file.

const srcDir = fileURLToPath(new URL('.', import.meta.url));

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(p);
    else if (/\.test\.ts$|testDaemon\.ts$/.test(entry.name)) yield p;
  }
}

// The text of each `spawnManaged(...)` call, by balanced parentheses.
function spawnCalls(source: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf('spawnManaged(', from);
    if (at < 0) return calls;
    let depth = 0;
    let end = at + 'spawnManaged'.length;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    calls.push(source.slice(at, end + 1));
    from = end;
  }
}

const PINNED = /pinnedFakeEnv\(|MAGARINE_ADAPTER|'--adapter'/;

test('every test that spawns the CLI pins the adapter (MAGARINE_ADAPTER=fake or --adapter)', () => {
  const unpinned: string[] = [];
  let spawns = 0;
  for (const file of files(srcDir)) {
    if (file.endsWith('cliSpawnPin.test.ts')) continue;
    for (const call of spawnCalls(readFileSync(file, 'utf8'))) {
      if (!call.includes('cliPath')) continue;
      spawns++;
      if (!PINNED.test(call)) unpinned.push(`${file}: ${call.split('\n')[0]}`);
    }
  }
  assert.ok(spawns >= 20, `expected to find the CLI spawn sites, found ${spawns}`);
  assert.deepEqual(unpinned, [], 'these spawns would launch the real Claude CLI');
});

test('the scanner is not vacuous: an unpinned spawn is seen, a pinned one is not flagged', () => {
  const bad = spawnCalls('x(); spawnManaged({ executable: process.execPath, args: [cliPath, ...args] }); y();');
  assert.equal(bad.length, 1);
  assert.ok(bad[0]!.includes('cliPath') && !PINNED.test(bad[0]!));
  const good = spawnCalls('spawnManaged({ env: pinnedFakeEnv(), args: [cliPath] })');
  assert.ok(PINNED.test(good[0]!));
});
