import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { artifactsDir, dbPath, resolveStateDir } from './paths.ts';

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
