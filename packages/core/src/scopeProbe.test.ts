import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeScopeFile, scopeAnnouncement } from './scopeProbe.ts';
import { testTempRoot } from './testSupport.ts';

// Ruling 29 (batch 16 addendum 5): the fs-backed probe, and the one line
// `project create` / `plan` print when the scope document is not there.

const testRoot = testTempRoot('scope-probe');
after(testRoot.cleanup);

test('probeScopeFile: a real file is present, a missing path (or missing parent) is absent, a directory at the path is unreadable', () => {
  const present = join(testRoot.root, 'SCOPE.md');
  writeFileSync(present, 'hello');
  assert.equal(probeScopeFile(present), 'present');
  assert.equal(probeScopeFile(join(testRoot.root, 'nope.md')), 'absent');
  assert.equal(probeScopeFile(join(testRoot.root, 'no-such-dir', 'SCOPE.md')), 'absent');
  const dirAtPath = join(testRoot.root, 'dir-at-path');
  mkdirSync(dirAtPath);
  // Not 'absent': the real cause travels as data, so the pause can name it.
  const result = probeScopeFile(dirAtPath);
  assert.ok(typeof result === 'object' && /^EISDIR: /.test(result.unreadable), `a directory at the scope path is unreadable with its real cause: ${JSON.stringify(result)}`);
});

test('scopeAnnouncement: the exact ruling 29 line, printed ONLY when the document is absent', () => {
  assert.equal(
    scopeAnnouncement('/p/SCOPE.md', () => 'absent'),
    'scope document: /p/SCOPE.md (not found; write it before plan, or the Manager will start by interviewing you)'
  );
  assert.equal(scopeAnnouncement('/p/SCOPE.md', () => 'present'), null);
  assert.equal(scopeAnnouncement('/p/SCOPE.md', () => ({ unreadable: 'EACCES: permission denied' })), null, 'unreadable is a readiness failure with its own pause, not this line');
  assert.equal(scopeAnnouncement(null, () => 'absent'), null, 'no scope path at all is a readiness failure, not this line');
});

// A permissions failure is the OTHER real cause, and it needs a different fix
// from a directory at the path. It is only reproducible where the OS enforces
// file modes (not Windows, not root): this test proves that itself first and
// SKIPS otherwise -- NOT OBSERVED, not faked.
test('probeScopeFile: a file the process cannot read is unreadable with its real EACCES cause (skipped where modes are not enforced)', async (t) => {
  const { chmodSync, accessSync, constants } = await import('node:fs');
  const path = join(testRoot.root, 'locked.md');
  writeFileSync(path, 'secret');
  chmodSync(path, 0o000);
  let enforced = false;
  try {
    accessSync(path, constants.R_OK);
  } catch {
    enforced = true;
  }
  if (!enforced) {
    chmodSync(path, 0o644);
    t.skip('this OS/user does not enforce file modes (Windows, or root): the EACCES case is NOT OBSERVED here');
    return;
  }
  const result = probeScopeFile(path);
  chmodSync(path, 0o644);
  assert.ok(typeof result === 'object' && /^EACCES: /.test(result.unreadable), JSON.stringify(result));
});
