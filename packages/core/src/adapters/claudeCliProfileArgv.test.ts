import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db/index.ts';
import { rmSyncResilient } from '../db/testSupport.ts';
import { ClaudeCliAdapter, renderProfileSystemPrompt } from './claudeCli.ts';
import { applyManagerProposal } from '../managerApply.ts';
import { tick } from '../scheduler.ts';
import { recordTicketTransition } from '../stateMachine.ts';
import { createProject, createTicket, getProject, getTicket, getWorkerProfileByName, updateWorkerProfile } from '../store.ts';
import type { Ticket } from '../types.ts';

// Batch 19 mini-phase 2A (ruling 37), acceptance line 4 and the spec's own
// "argv safety" requirement: these tests go through the REAL path -- a
// Manager proposal (proposal.ts's validator) applied by managerApply.ts,
// scheduled by scheduler.ts, spawned by the REAL ClaudeCliAdapter (never
// FakeAdapter/TestAdapter) against a fake `claude` executable that writes
// back the actual argv it was invoked with. This is the one place that can
// prove `--append-system-prompt` reaches the real command line unmangled --
// scheduler.test.ts's TestAdapter proves the envelope carries the right
// `profile` field, but never builds an argv array at all.

const fakeExePath = fileURLToPath(new URL('./testFixtures/fakeClaudeExe.ts', import.meta.url));

function makeManagerTicket(db: ReturnType<typeof openDb>, projectId: string): Ticket {
  const ticket = createTicket(db, {
    projectId,
    title: 'Plan: mission',
    description: 'mission text',
    kind: 'manager',
    workspaceType: 'NONE',
  });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: `dr:${ticket.id}` });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: `rs:${ticket.id}` });
  return getTicket(db, ticket.id)!;
}

// The result status is deliberately `needs_user_decision`, not `done`: a
// "done" work ticket (batch 18 ruling 31) lands in REVIEW and the scheduler
// chains STRAIGHT into a second, verifier run on the SAME adapter instance
// before `s.done` ever resolves -- which would silently overwrite this
// single, shared `argvFile` with the VERIFIER's own argv (its envelope
// never carries a profile either, so that overwrite would make this test
// pass for the wrong reason: reading a different run's argv entirely,
// rather than proving the WORK run's own argv carries the flag).
// `needs_user_decision` moves the ticket to BLOCKED instead, with no
// verifier chained, so `argvFile` still holds exactly the one, real work
// run's argv when the test reads it back.
function successSpec(argvFile: string, stdoutFile: string): Record<string, unknown> {
  return {
    exitCode: 0,
    argvFile,
    stdoutFile,
    createFiles: {
      '.orchestrator/result.json': JSON.stringify({
        status: 'needs_user_decision',
        summary: 'ok',
        artifacts: [],
        checks: [],
        blockers: ['fake blocker'],
        questions: [],
      }),
    },
  };
}

test('renderProfileSystemPrompt renders "You are <name>, <purpose>. <policy>", omitting the trailing policy when it is empty', () => {
  assert.equal(
    renderProfileSystemPrompt({ name: 'Developer', purpose: 'implementation', policy: 'Be terse.' }),
    'You are Developer, implementation. Be terse.'
  );
  assert.equal(renderProfileSystemPrompt({ name: 'Developer', purpose: 'implementation', policy: '' }), 'You are Developer, implementation.');
});

test('a profile assigned through a real Manager proposal reaches the real adapter argv as --append-system-prompt with the exact rendered line, safely, even with quotes, an ampersand and a newline in the profile\'s purpose/policy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magarine-profile-argv-'));
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'magarine-profile-argv-ws-'));
  const argvFile = join(dir, 'argv.json');
  const stdoutFile = join(dir, 'stdout.txt');
  writeFileSync(stdoutFile, JSON.stringify({ type: 'result', total_cost_usd: 0.001 }) + '\n');
  try {
    const db = openDb(':memory:');
    const project = createProject(db, { name: 'p', maxParallelWorkers: 1, workspaceRoot });
    const managerTicket = makeManagerTicket(db, project.id);

    // A purpose and policy deliberately hostile to a shell (double quotes,
    // an ampersand -- Windows cmd.exe's own command separator -- and a
    // literal newline), all through the REAL createWorkerProfile/
    // updateWorkerProfile validators, not hand-passed.
    const weirdPurpose = 'implementation with "quotes", an & sign,\nand a newline';
    const weirdPolicy = 'Escape nothing: "double", \'single\', & ampersands\nand more newlines.';
    const developer = getWorkerProfileByName(db, 'Developer')!;
    updateWorkerProfile(db, developer.id, { purpose: weirdPurpose, policy: weirdPolicy });

    const applied = applyManagerProposal(db, managerTicket, getProject(db, project.id)!, 'run_1', {
      rationale: 'assign the roster',
      commands: [
        {
          type: 'create_ticket',
          title: 'Implement it',
          description: 'd',
          acceptance_criteria: [],
          profile: 'Developer',
          profile_reason: 'ordinary implementation work',
        },
      ],
    });
    assert.equal(applied.outcome, 'applied');
    if (applied.outcome !== 'applied') return;
    const created = getTicket(db, applied.created[0]!.ticketId)!;
    assert.equal(created.profileId, developer.id, 'sanity: the ticket really carries the profile assigned through the proposal');

    const adapter = new ClaudeCliAdapter({
      claudeExe: process.execPath,
      argsPrefix: [fakeExePath],
      maxBudgetUsd: 2,
      workspaceType: 'DIRECTORY',
      workspaceRoot,
      env: { MAGARINE_FAKE_SPEC: JSON.stringify(successSpec(argvFile, stdoutFile)) },
    });

    const { started } = await tick({ readiness: 'skip', db, adapter, maxParallelWorkers: 1, projectId: project.id });
    const s = started.find((x) => x.ticketId === created.id)!;
    await s.done;

    const argv: string[] = JSON.parse(readFileSync(argvFile, 'utf8'));
    const flagIndex = argv.indexOf('--append-system-prompt');
    assert.ok(flagIndex >= 0, '--append-system-prompt must be on the real command line');
    const expected = `You are Developer, ${weirdPurpose}. ${weirdPolicy}`;
    assert.equal(argv[flagIndex + 1], expected, 'the argv element must carry the exact rendered line, unmangled by any shell');
    // The raw characters survived untouched in ONE argv element -- proof
    // this was never shell-interpolated (shell:false, process.ts's own
    // header comment): a real shell would have split on the newline/&, or
    // needed the quotes escaped, long before this assertion could pass.
    assert.ok(argv[flagIndex + 1]!.includes('"quotes"'));
    assert.ok(argv[flagIndex + 1]!.includes('&'));
    assert.ok(argv[flagIndex + 1]!.includes('\n'));
  } finally {
    await rmSyncResilient(workspaceRoot);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Batch 19 mini-phase 2A fix round (review Low 6): the create_ticket test
// above never exercises managerApply.ts's SEPARATE update_ticket branch --
// dropping `profile: c.profile` there (managerApply.ts's update_ticket case)
// would still pass that test, and scheduler.test.ts's own envelope tests
// hand the profile to createTicket directly rather than through a Manager
// proposal. This is the one test that walks proposal -> apply -> scheduler
// -> real adapter argv for UPDATE_TICKET specifically.
test('a profile assigned through a real Manager update_ticket proposal reaches the real adapter argv as --append-system-prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magarine-profile-argv-update-'));
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'magarine-profile-argv-update-ws-'));
  const argvFile = join(dir, 'argv.json');
  const stdoutFile = join(dir, 'stdout.txt');
  writeFileSync(stdoutFile, JSON.stringify({ type: 'result', total_cost_usd: 0.001 }) + '\n');
  try {
    const db = openDb(':memory:');
    const project = createProject(db, { name: 'p', maxParallelWorkers: 1, workspaceRoot });
    const managerTicket = makeManagerTicket(db, project.id);
    const target = createTicket(db, { projectId: project.id, title: 'Not yet assigned' });
    const developer = getWorkerProfileByName(db, 'Developer')!;

    const applied = applyManagerProposal(db, managerTicket, getProject(db, project.id)!, 'run_1', {
      rationale: 'assign the roster',
      commands: [{ type: 'update_ticket', ticket_id: target.id, profile: 'Developer', profile_reason: 'ordinary implementation work' }],
    });
    assert.equal(applied.outcome, 'applied');
    assert.equal(getTicket(db, target.id)!.profileId, developer.id, 'sanity: update_ticket really assigned the profile');

    const adapter = new ClaudeCliAdapter({
      claudeExe: process.execPath,
      argsPrefix: [fakeExePath],
      maxBudgetUsd: 2,
      workspaceType: 'DIRECTORY',
      workspaceRoot,
      env: { MAGARINE_FAKE_SPEC: JSON.stringify(successSpec(argvFile, stdoutFile)) },
    });

    const { started } = await tick({ readiness: 'skip', db, adapter, maxParallelWorkers: 1, projectId: project.id });
    const s = started.find((x) => x.ticketId === target.id)!;
    await s.done;

    const argv: string[] = JSON.parse(readFileSync(argvFile, 'utf8'));
    const flagIndex = argv.indexOf('--append-system-prompt');
    assert.ok(flagIndex >= 0, '--append-system-prompt must be on the real command line for a profile assigned via update_ticket');
    // Developer's seeded policy is its purpose sentence again, verbatim
    // (migration 0017's own comment), so the rendered line repeats it.
    assert.equal(argv[flagIndex + 1], 'You are Developer, implementation. implementation');
  } finally {
    await rmSyncResilient(workspaceRoot);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a profile-less ticket\'s real adapter argv carries no --append-system-prompt flag at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magarine-profile-argv-none-'));
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'magarine-profile-argv-none-ws-'));
  const argvFile = join(dir, 'argv.json');
  const stdoutFile = join(dir, 'stdout.txt');
  writeFileSync(stdoutFile, JSON.stringify({ type: 'result', total_cost_usd: 0.001 }) + '\n');
  try {
    const db = openDb(':memory:');
    const project = createProject(db, { name: 'p', maxParallelWorkers: 1, workspaceRoot });
    const ticket = createTicket(db, { projectId: project.id, title: 'No profile here' });

    const adapter = new ClaudeCliAdapter({
      claudeExe: process.execPath,
      argsPrefix: [fakeExePath],
      maxBudgetUsd: 2,
      workspaceType: 'DIRECTORY',
      workspaceRoot,
      env: { MAGARINE_FAKE_SPEC: JSON.stringify(successSpec(argvFile, stdoutFile)) },
    });

    const { started } = await tick({ readiness: 'skip', db, adapter, maxParallelWorkers: 1, projectId: project.id });
    const s = started.find((x) => x.ticketId === ticket.id)!;
    await s.done;

    const argv: string[] = JSON.parse(readFileSync(argvFile, 'utf8'));
    assert.equal(argv.indexOf('--append-system-prompt'), -1);
  } finally {
    await rmSyncResilient(workspaceRoot);
    rmSync(dir, { recursive: true, force: true });
  }
});
