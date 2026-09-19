import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectReadiness } from './readiness.ts';
import { validateWorkspaceRoot } from './paths.ts';

import type { ScopeProbe } from './readiness.ts';

const HOME = join('C:', 'fake-home');
const PRESENT: ScopeProbe = () => 'present';
const STATE = join('C:', 'fake-home', '.magarine');
const GOOD_DIR = join('C:', 'fake-home', 'projects', 'app');
const GOOD = { id: 'proj_1', workspaceRoot: GOOD_DIR, scopePath: join(GOOD_DIR, 'SCOPE.md') };

test('projectReadiness: a project with a safe directory and a scope path is ready (null)', () => {
  assert.equal(projectReadiness(GOOD, STATE, PRESENT, HOME), null);
});

test('projectReadiness: no workspace_root -> missing_workspace_root, naming the one fix command with the id filled in', () => {
  const r = projectReadiness({ ...GOOD, workspaceRoot: null }, STATE, PRESENT, HOME);
  assert.equal(r?.rule, 'missing_workspace_root');
  assert.equal(r?.fix, 'magarine project set --project proj_1 --dir <folder>');
  assert.match(r!.message, /magarine project set --project proj_1 --dir <folder>/);
});

test('projectReadiness: an unsafe workspace_root -> unsafe_workspace_root, carrying ruling 22\'s own message verbatim, for each of its three shapes', () => {
  for (const dir of [HOME, 'D:\\', STATE, join('C:', 'fake-home')]) {
    const r = projectReadiness({ ...GOOD, workspaceRoot: dir }, STATE, PRESENT, HOME);
    assert.equal(r?.rule, 'unsafe_workspace_root', `${dir} must be unsafe`);
    assert.equal(r?.message, validateWorkspaceRoot(dir, HOME, STATE));
  }
});

test('projectReadiness: a safe directory but no scope_path -> missing_scope_path', () => {
  const r = projectReadiness({ ...GOOD, scopePath: null }, STATE, PRESENT, HOME);
  assert.equal(r?.rule, 'missing_scope_path');
  assert.match(r!.fix, /--dir <folder>/);
});

test('projectReadiness: rules are ordered -- a row failing several reports the first (no directory beats no scope; unsafe beats no scope)', () => {
  assert.equal(projectReadiness({ workspaceRoot: null, scopePath: null }, STATE, PRESENT, HOME)?.rule, 'missing_workspace_root');
  assert.equal(projectReadiness({ workspaceRoot: HOME, scopePath: null }, STATE, PRESENT, HOME)?.rule, 'unsafe_workspace_root');
});

test('projectReadiness: a candidate with no id (project create, before a row exists) names <projectId> in the fix', () => {
  const r = projectReadiness({ workspaceRoot: null, scopePath: null }, STATE, PRESENT, HOME);
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

// Ruling 29 (batch 16 addendum 5): the scope document's state enters through an
// injected probe, so these run without touching disk.
// Each cause is STUBBED through the probe (no disk) and the message must name
// the path AND that cause's real error -- the causes need different fixes
// (repair permissions vs. remove what is at the path), so the owner must not
// be left to guess between them.
for (const [label, error] of [
  ['permissions', 'EACCES: permission denied'],
  ['a directory at the path', 'EISDIR: something that is not a file (a directory) is at this path'],
  ['an I/O failure', 'EIO: i/o error'],
] as const) {
  test(`projectReadiness: an UNREADABLE scope file (${label}) -> unreadable_scope_file, naming the path AND the real error, and the resume fix`, () => {
    const r = projectReadiness(GOOD, STATE, () => ({ unreadable: error }), HOME);
    assert.equal(r?.rule, 'unreadable_scope_file');
    assert.ok(r!.message.includes(GOOD.scopePath), `names the path: ${r!.message}`);
    assert.ok(r!.message.includes(error), `names the real error: ${r!.message}`);
    assert.ok(!/permissions problem, or a directory/.test(r!.message), 'no either/or guess between causes');
    assert.equal(r!.detail, error);
    assert.equal(r!.fix, 'magarine resume --project proj_1');
  });
}

test('projectReadiness: two different causes give two different messages', () => {
  const a = projectReadiness(GOOD, STATE, () => ({ unreadable: 'EACCES: permission denied' }), HOME)!;
  const b = projectReadiness(GOOD, STATE, () => ({ unreadable: 'EISDIR: a directory is at this path' }), HOME)!;
  assert.notEqual(a.message, b.message);
});

test('projectReadiness: an ABSENT scope file is NOT a readiness failure (the talk-first start is deliberate)', () => {
  assert.equal(projectReadiness(GOOD, STATE, () => 'absent', HOME), null);
});

test('projectReadiness: the probe is asked about the project\'s own scope path, and only after the earlier rules pass', () => {
  const asked: string[] = [];
  const probe: ScopeProbe = (p) => (asked.push(p), 'present');
  assert.equal(projectReadiness(GOOD, STATE, probe, HOME), null);
  assert.deepEqual(asked, [GOOD.scopePath]);
  asked.length = 0;
  projectReadiness({ ...GOOD, workspaceRoot: null }, STATE, probe, HOME);
  projectReadiness({ ...GOOD, scopePath: null }, STATE, probe, HOME);
  assert.deepEqual(asked, [], 'a failing earlier rule (or no path at all) never touches the probe');
});

test('readiness.ts stays pure: it does not import fs', () => {
  const source = readFileSync(new URL('./readiness.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from 'node:fs'/);
});
