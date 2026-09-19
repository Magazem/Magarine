import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { artifactsDir, dbPath, resolveStateDir, validateWorkspaceRoot } from './paths.ts';

const FAKE_HOME = join('C:', 'fake-home');

test('resolveStateDir: --state-dir flag wins over everything', () => {
  const result = resolveStateDir({
    stateDirFlag: join('C:', 'explicit', 'state'),
    env: { MAGARINE_HOME: join('C:', 'env', 'state') },
    homedir: FAKE_HOME,
  });
  assert.equal(result, join('C:', 'explicit', 'state'));
});

test('resolveStateDir: falls back to MAGARINE_HOME when no flag is given', () => {
  const result = resolveStateDir({
    env: { MAGARINE_HOME: join('C:', 'env', 'state') },
    homedir: FAKE_HOME,
  });
  assert.equal(result, join('C:', 'env', 'state'));
});

test('resolveStateDir: falls back to <home>/.magarine when neither flag nor env is given', () => {
  const result = resolveStateDir({
    env: {},
    homedir: FAKE_HOME,
  });
  assert.equal(result, join(FAKE_HOME, '.magarine'));
});

test('resolveStateDir: an empty-string MAGARINE_HOME is treated as absent, not as a path', () => {
  const result = resolveStateDir({
    env: { MAGARINE_HOME: '' },
    homedir: FAKE_HOME,
  });
  assert.equal(result, join(FAKE_HOME, '.magarine'));
});

test('dbPath: database lives at <state>/magarine.db', () => {
  const stateDir = join('C:', 'some', 'state');
  assert.equal(dbPath(stateDir), join(stateDir, 'magarine.db'));
});

test('artifactsDir: artefacts live at <state>/artifacts', () => {
  const stateDir = join('C:', 'some', 'state');
  assert.equal(artifactsDir(stateDir), join(stateDir, 'artifacts'));
});

// Ruling 22 (batch 15 addendum 10): `dir` is the CANDIDATE project
// directory, `homeDir`/`resolvedStateDir` are injected -- see this
// function's own doc comment for why neither is ever read from a real
// `os.homedir()`/`resolveStateDir()` here, which is what lets the
// home-directory rule below be proven without a real invocation.
const FAKE_STATE_DIR = join('C:', 'fake-home', '.magarine');

test('validateWorkspaceRoot: refuses the home directory, naming the fix', () => {
  const message = validateWorkspaceRoot(FAKE_HOME, FAKE_HOME, FAKE_STATE_DIR);
  assert.ok(message);
  assert.match(message!, /home directory/);
  assert.match(message!, /make a folder for the project and run this from inside it/);
});

test('validateWorkspaceRoot: refuses a filesystem root, naming the fix', () => {
  // 'D:\\' is a filesystem root's own literal form (path.parse('D:\\').root
  // === 'D:\\' on Windows) -- not derived via join()/resolve(), so this
  // does not depend on those functions' own normalisation happening to
  // agree with parse()'s root detection.
  const message = validateWorkspaceRoot('D:\\', FAKE_HOME, FAKE_STATE_DIR);
  assert.ok(message);
  assert.match(message!, /filesystem root/);
  assert.match(message!, /make a folder for the project and run this from inside it/);
});

test('validateWorkspaceRoot: refuses a directory that IS the state directory, naming --state-dir', () => {
  const message = validateWorkspaceRoot(FAKE_STATE_DIR, FAKE_HOME, FAKE_STATE_DIR);
  assert.ok(message);
  assert.match(message!, /state directory/);
  assert.match(message!, /--state-dir/);
});

test('validateWorkspaceRoot: refuses a directory that CONTAINS (is an ancestor of) the state directory', () => {
  const ancestor = join('C:', 'fake-home');
  const stateDir = join(ancestor, '.magarine');
  const message = validateWorkspaceRoot(ancestor, join('C:', 'somewhere-else'), stateDir);
  assert.ok(message);
  assert.match(message!, /state directory/);
  assert.match(message!, /--state-dir/);
});

test('validateWorkspaceRoot: a plain project subdirectory, none of the three, is accepted', () => {
  const message = validateWorkspaceRoot(
    join('C:', 'fake-home', 'projects', 'my-app'),
    FAKE_HOME,
    FAKE_STATE_DIR
  );
  assert.equal(message, null);
});
