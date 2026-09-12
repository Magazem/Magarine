import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

test('exactly one source file writes tickets.status', () => {
  const srcDir = join(import.meta.dirname, '.');
  const files = listTsFiles(srcDir);
  const writers: string[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    if (/UPDATE\s+tickets\s+SET[^;]*\bstatus\s*=/is.test(content)) {
      writers.push(file);
    }
  }

  assert.deepEqual(
    writers.map((f) => f.replace(srcDir, '').replace(/\\/g, '/')),
    ['/stateMachine.ts']
  );
});
