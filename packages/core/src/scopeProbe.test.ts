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
  assert.equal(probeScopeFile(dirAtPath), 'unreadable', 'a directory at the scope path is not "absent"');
});

test('scopeAnnouncement: the exact ruling 29 line, printed ONLY when the document is absent', () => {
  assert.equal(
    scopeAnnouncement('/p/SCOPE.md', () => 'absent'),
    'scope document: /p/SCOPE.md (not found; write it before plan, or the Manager will start by interviewing you)'
  );
  assert.equal(scopeAnnouncement('/p/SCOPE.md', () => 'present'), null);
  assert.equal(scopeAnnouncement('/p/SCOPE.md', () => 'unreadable'), null, 'unreadable is a readiness failure with its own pause, not this line');
  assert.equal(scopeAnnouncement(null, () => 'absent'), null, 'no scope path at all is a readiness failure, not this line');
});
