import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectReadiness } from './readiness.ts';
import { validateWorkspaceRoot } from './paths.ts';

const HOME = join('C:', 'fake-home');
const STATE = join('C:', 'fake-home', '.magarine');
const GOOD_DIR = join('C:', 'fake-home', 'projects', 'app');
const GOOD = { id: 'proj_1', workspaceRoot: GOOD_DIR, scopePath: join(GOOD_DIR, 'SCOPE.md') };

test('projectReadiness: a project with a safe directory and a scope path is ready (null)', () => {
  assert.equal(projectReadiness(GOOD, STATE, HOME), null);
});

test('projectReadiness: no workspace_root -> missing_workspace_root, naming the one fix command with the id filled in', () => {
  const r = projectReadiness({ ...GOOD, workspaceRoot: null }, STATE, HOME);
  assert.equal(r?.rule, 'missing_workspace_root');
  assert.equal(r?.fix, 'magarine project set --project proj_1 --dir <folder>');
  assert.match(r!.message, /magarine project set --project proj_1 --dir <folder>/);
});

test('projectReadiness: an unsafe workspace_root -> unsafe_workspace_root, carrying ruling 22\'s own message verbatim, for each of its three shapes', () => {
  for (const dir of [HOME, 'D:\\', STATE, join('C:', 'fake-home')]) {
    const r = projectReadiness({ ...GOOD, workspaceRoot: dir }, STATE, HOME);
    assert.equal(r?.rule, 'unsafe_workspace_root', `${dir} must be unsafe`);
    assert.equal(r?.message, validateWorkspaceRoot(dir, HOME, STATE));
  }
});

test('projectReadiness: a safe directory but no scope_path -> missing_scope_path', () => {
  const r = projectReadiness({ ...GOOD, scopePath: null }, STATE, HOME);
  assert.equal(r?.rule, 'missing_scope_path');
  assert.match(r!.fix, /--dir <folder>/);
});

test('projectReadiness: rules are ordered -- a row failing several reports the first (no directory beats no scope; unsafe beats no scope)', () => {
  assert.equal(projectReadiness({ workspaceRoot: null, scopePath: null }, STATE, HOME)?.rule, 'missing_workspace_root');
  assert.equal(projectReadiness({ workspaceRoot: HOME, scopePath: null }, STATE, HOME)?.rule, 'unsafe_workspace_root');
});

test('projectReadiness: a candidate with no id (project create, before a row exists) names <projectId> in the fix', () => {
  const r = projectReadiness({ workspaceRoot: null, scopePath: null }, STATE, HOME);
  assert.equal(r?.fix, 'magarine project set --project <projectId> --dir <folder>');
});

// The sharing itself (ruling 24 point 1): two behaviourally identical copies
// of ruling 22's check cannot be told apart by any behavioural test, so the
// guarantee that the sites cannot drift is asserted on the source: every
// site that asks the question goes through `projectReadiness`, and none calls
// the rule function underneath it (`validateWorkspaceRoot`) on its own.
test('cli.ts, scheduler.ts and projectList.ts all ask projectReadiness and none calls validateWorkspaceRoot itself', () => {
  for (const file of ['cli.ts', 'scheduler.ts', 'commands/projectList.ts']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.match(source, /projectReadiness\(/, `${file} must call projectReadiness`);
    assert.doesNotMatch(source, /validateWorkspaceRoot/, `${file} must not keep its own copy of ruling 22's check`);
  }
});
