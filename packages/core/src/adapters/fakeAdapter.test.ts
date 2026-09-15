import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter } from './fakeAdapter.ts';
import type { TicketEnvelope, WorkerEvent } from '../types.ts';

function envelope(ticketId: string): TicketEnvelope {
  return {
    ticketId,
    projectBrief: 'brief',
    relevantDecisions: [],
    title: 't',
    description: 'd',
    acceptanceCriteria: [],
    completedDependencies: [],
    allowedTools: [],
    expectedOutputFormat: 'json',
  };
}

async function collectEvents(adapter: FakeAdapter, ticketId: string, count: number): Promise<WorkerEvent[]> {
  const handle = await adapter.startWorker({ ticket: envelope(ticketId), systemPolicy: 'p' });
  const events: WorkerEvent[] = [];
  await new Promise<void>((resolve) => {
    adapter.observe(handle, (event) => {
      events.push(event);
      if (events.length >= count) resolve();
    });
  });
  return events;
}

test('succeed script emits a done result', async () => {
  const adapter = new FakeAdapter();
  adapter.setScript('t1', { kind: 'succeed' });
  const [event] = await collectEvents(adapter, 't1', 1);
  assert.equal(event.type, 'result_raw');
  assert.equal((event as { raw: { status: string } }).raw.status, 'done');
});

test('retryable_failure script emits a retryable failure event', async () => {
  const adapter = new FakeAdapter();
  adapter.setScript('t1', { kind: 'retryable_failure' });
  const [event] = await collectEvents(adapter, 't1', 1);
  assert.equal(event.type, 'failure');
  assert.equal((event as { retryable: boolean }).retryable, true);
});

test('question script emits a question event then a done result', async () => {
  const adapter = new FakeAdapter();
  adapter.setScript('t1', { kind: 'question' });
  const events = await collectEvents(adapter, 't1', 2);
  assert.equal(events[0].type, 'question');
  assert.equal(events[1].type, 'result_raw');
});

test('needs_user_decision script emits a result with that status', async () => {
  const adapter = new FakeAdapter();
  adapter.setScript('t1', { kind: 'needs_user_decision' });
  const [event] = await collectEvents(adapter, 't1', 1);
  assert.equal(event.type, 'result_raw');
  assert.equal((event as { raw: { status: string } }).raw.status, 'needs_user_decision');
});

test('malformed_result script emits a result_raw payload that fails validation', async () => {
  const adapter = new FakeAdapter();
  adapter.setScript('t1', { kind: 'malformed_result' });
  const [event] = await collectEvents(adapter, 't1', 1);
  assert.equal(event.type, 'result_raw');
  assert.equal((event as { raw: { status?: string } }).raw.status, undefined);
});

test('review script emits a result with status review and the given summary (batch 5 item 5)', async () => {
  const adapter = new FakeAdapter();
  adapter.setScript('t1', { kind: 'review', summary: 'please look at this' });
  const [event] = await collectEvents(adapter, 't1', 1);
  assert.equal(event.type, 'result_raw');
  assert.equal((event as { raw: { status: string; summary: string } }).raw.status, 'review');
  assert.equal((event as { raw: { status: string; summary: string } }).raw.summary, 'please look at this');
});

test('final script emits a non-retryable failure (batch 5 item 5)', async () => {
  const adapter = new FakeAdapter();
  adapter.setScript('t1', { kind: 'final', message: 'not coming back from this' });
  const [event] = await collectEvents(adapter, 't1', 1);
  assert.equal(event.type, 'failure');
  assert.equal((event as { retryable: boolean }).retryable, false);
  assert.equal((event as { message: string }).message, 'not coming back from this');
});

test('budget_insufficient script emits a result with that status and the worker\'s reasoning as summary (batch 7)', async () => {
  const adapter = new FakeAdapter();
  adapter.setScript('t1', { kind: 'budget_insufficient', summary: 'per-turn cost makes this impossible within budget' });
  const [event] = await collectEvents(adapter, 't1', 1);
  assert.equal(event.type, 'result_raw');
  assert.equal((event as { raw: { status: string } }).raw.status, 'budget_insufficient');
  assert.equal(
    (event as { raw: { summary: string } }).raw.summary,
    'per-turn cost makes this impossible within budget'
  );
});

test('hang script never emits any event', async () => {
  const adapter = new FakeAdapter();
  adapter.setScript('t1', { kind: 'hang' });
  const handle = await adapter.startWorker({ ticket: envelope('t1'), systemPolicy: 'p' });
  let called = false;
  await adapter.observe(handle, () => {
    called = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(called, false);
});

test('stop() cancels a pending scripted event before it fires, but still publishes its own post-stop terminal failure', async () => {
  // Batch 5 fidelity rule: the real adapter's killed process still resolves
  // its own wait() promise and publishes a terminal outcome after stop() is
  // called, regardless of what the run was doing. The fake must mirror
  // that, not go silent -- see fakeAdapter.ts's stop() for why (this is the
  // exact behaviour batch-4-closeout.md section 2's crash needed and 194
  // green tests could not see, because this fake used to have none of it).
  const adapter = new FakeAdapter();
  adapter.setScript('t1', { kind: 'succeed', delayMs: 50 });
  const handle = await adapter.startWorker({ ticket: envelope('t1'), systemPolicy: 'p' });
  const events: WorkerEvent[] = [];
  await adapter.observe(handle, (event) => {
    events.push(event);
  });

  await adapter.stop(handle);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(events.length, 1, 'the scheduled succeed event must be suppressed; only the post-stop event fires');
  assert.equal(events[0].type, 'failure', "mirrors the real adapter: a killed process's own wait() still resolves and publishes");
});

test('destroy() is safe to call on an already-stopped handle', async () => {
  const adapter = new FakeAdapter();
  adapter.setScript('t1', { kind: 'hang' });
  const handle = await adapter.startWorker({ ticket: envelope('t1'), systemPolicy: 'p' });
  await adapter.observe(handle, () => {});
  await adapter.stop(handle);
  await assert.doesNotReject(() => adapter.destroy(handle));
});

// Batch 9: manager_proposal writes a real file into the real workspace it
// was given -- proven against the actual filesystem, not just the returned
// event, the same discipline claudeCli.test.ts's leak-detection test uses.
test('manager_proposal script writes proposal.json into the real workspace and declares it as an artifact', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'magarine-fakeadapter-manager-'));
  try {
    const adapter = new FakeAdapter();
    const proposal = { commands: [{ type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [] }], rationale: 'r' };
    adapter.setScript('t1', { kind: 'manager_proposal', proposal });
    const handle = await adapter.startWorker({ ticket: envelope('t1'), workspace: { type: 'NONE', path: workspace }, systemPolicy: 'p' });

    const events: WorkerEvent[] = [];
    await new Promise<void>((resolve) => {
      adapter.observe(handle, (event) => {
        events.push(event);
        resolve();
      });
    });

    const written = JSON.parse(readFileSync(join(workspace, '.orchestrator', 'proposal.json'), 'utf8'));
    assert.deepEqual(written, proposal);

    const terminal = events.at(-1)! as { type: string; raw: { status: string; artifacts: Array<{ kind: string; path: string }> } };
    assert.equal(terminal.type, 'result_raw');
    assert.equal(terminal.raw.status, 'done');
    assert.deepEqual(terminal.raw.artifacts, [{ kind: 'file', path: '.orchestrator/proposal.json' }]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('manager_proposal script with no proposal given writes nothing and declares no artifact', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'magarine-fakeadapter-manager-none-'));
  try {
    const adapter = new FakeAdapter();
    adapter.setScript('t1', { kind: 'manager_proposal' });
    const handle = await adapter.startWorker({ ticket: envelope('t1'), workspace: { type: 'NONE', path: workspace }, systemPolicy: 'p' });

    const events: WorkerEvent[] = [];
    await new Promise<void>((resolve) => {
      adapter.observe(handle, (event) => {
        events.push(event);
        resolve();
      });
    });

    assert.equal(existsSync(join(workspace, '.orchestrator', 'proposal.json')), false);
    const terminal = events.at(-1)! as { type: string; raw: { artifacts: unknown[] } };
    assert.deepEqual(terminal.raw.artifacts, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('manager_proposal script with extraArtifacts declares them alongside (or instead of) proposal.json, without writing any file for them', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'magarine-fakeadapter-manager-extra-'));
  try {
    const adapter = new FakeAdapter();
    adapter.setScript('t1', {
      kind: 'manager_proposal',
      proposal: { rationale: 'r', commands: [] },
      extraArtifacts: [
        { kind: 'manager_reply', text: 'Here is my reply.' },
        { kind: 'manager_assessment', text: 'Here is my assessment.' },
      ],
    });
    const handle = await adapter.startWorker({ ticket: envelope('t1'), workspace: { type: 'NONE', path: workspace }, systemPolicy: 'p' });

    const events: WorkerEvent[] = [];
    await new Promise<void>((resolve) => {
      adapter.observe(handle, (event) => {
        events.push(event);
        resolve();
      });
    });

    const terminal = events.at(-1)! as { type: string; raw: { artifacts: Array<Record<string, string>> } };
    assert.deepEqual(terminal.raw.artifacts, [
      { kind: 'file', path: '.orchestrator/proposal.json' },
      { kind: 'manager_reply', text: 'Here is my reply.' },
      { kind: 'manager_assessment', text: 'Here is my assessment.' },
    ]);
    // No file is ever written for a non-'file' extraArtifact -- the text is
    // opaque content, not a filesystem location (see managerEnvelope.ts's
    // MANAGER_EXPECTED_OUTPUT_FORMAT).
    assert.equal(existsSync(join(workspace, 'Here is my reply.')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
