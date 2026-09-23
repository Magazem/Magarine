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

// ---- Batch 20A review: the check compares REAL paths -----------------------

import { mkdirSync as mkdirReal, mkdtempSync as mkdtempReal, symlinkSync, realpathSync as realpathReal } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep as pathSep } from 'node:path';
import { canonicalPath } from './paths.ts';

const realRoot = realpathReal(mkdtempReal(join(tmpdir(), 'magarine-paths-real-')));
const realHome = join(realRoot, 'home');
const realState = join(realHome, '.magarine');
mkdirReal(realState, { recursive: true });
mkdirReal(join(realHome, 'projects', 'app'), { recursive: true });

function tryJunction(target: string, name: string): string | null {
  const link = join(realRoot, name);
  try {
    symlinkSync(target, link, 'junction');
    return link;
  } catch {
    return null;
  }
}

test('validateWorkspaceRoot: home in another case, with a trailing separator, is still the home directory (Windows folds case)', (t) => {
  if (process.platform !== 'win32') return t.skip('case-insensitive filesystems only');
  assert.match(validateWorkspaceRoot(realHome.toUpperCase(), realHome, realState) ?? '', /home directory/);
  assert.match(validateWorkspaceRoot(realHome.toLowerCase() + pathSep, realHome, realState) ?? '', /home directory/);
});

test('validateWorkspaceRoot: the state directory in another case, or with a trailing separator, is refused', (t) => {
  assert.match(validateWorkspaceRoot(realState + pathSep, realHome, realState) ?? '', /state directory/);
  if (process.platform !== 'win32') return t.skip('case folding: Windows only');
  assert.match(validateWorkspaceRoot(realState.toUpperCase(), realHome, realState) ?? '', /state directory/);
});

test('validateWorkspaceRoot: a junction to the home directory is the home directory', (t) => {
  const link = tryJunction(realHome, 'junction-to-home');
  if (!link) return t.skip('COULD NOT create a junction/symlink on this machine -- the junction spelling is UNTESTED here');
  assert.match(validateWorkspaceRoot(link, realHome, realState) ?? '', /home directory/);
});

test('validateWorkspaceRoot: a junction to the state directory is refused, and so is a path through it', (t) => {
  const link = tryJunction(realState, 'junction-to-state');
  if (!link) return t.skip('COULD NOT create a junction/symlink on this machine -- the junction spelling is UNTESTED here');
  assert.match(validateWorkspaceRoot(link, realHome, realState) ?? '', /state directory/);
  assert.match(validateWorkspaceRoot(join(link, 'sub'), realHome, realState) ?? '', /state directory/, 'a not-yet-existing folder under the junction resolves through it');
});

test('validateWorkspaceRoot: a directory INSIDE the state directory is refused; a sibling of it is fine', () => {
  const inside = join(realState, 'sub');
  assert.match(validateWorkspaceRoot(inside, realHome, realState) ?? '', /is, contains or is inside/);
  assert.equal(validateWorkspaceRoot(join(realHome, 'projects', 'app'), realHome, realState), null);
  assert.equal(validateWorkspaceRoot(join(realHome, '.magarine-projects'), realHome, realState), null, 'a name that merely starts like the state dir is not inside it');
});

test('canonicalPath: a folder that does not exist yet is its nearest existing ancestor\'s real path plus the rest', () => {
  const missing = join(realHome, 'projects', 'not', 'yet');
  assert.equal(canonicalPath(missing, 'linux'), join(realpathReal(realHome), 'projects', 'not', 'yet'));
});
