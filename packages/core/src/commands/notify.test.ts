import test from 'node:test';
import assert from 'node:assert/strict';
import type { StreamedEvent } from '../daemonClient.ts';
import { TOAST_EVENT_TYPES, TOAST_POWERSHELL_ARGS, TOAST_TITLE, raiseToast, runNotifier, toastFor, type NotifierSeams, type Toast } from './notify.ts';

// Batch 17 item 4b: the HOST raises the Needs You toast. One toast per
// qualifying event after the notifier starts, nothing for any other event, and
// the owner's own text (a ticket title) on PowerShell's STDIN -- never on a
// command line, where every process on their machine can read it.

const START = Date.parse('2026-09-20T12:00:00.000Z');

function ev(type: string, over: Record<string, unknown> = {}, id = 1): StreamedEvent {
  return {
    id,
    event: type,
    data: { sequence: id, projectId: 'proj_1', eventType: type, entityType: 'ticket', entityId: 'tkt_1', payload: {}, createdAt: '2026-09-20T12:00:05.000Z', ...over },
  };
}

async function* stream(events: StreamedEvent[]): AsyncGenerator<StreamedEvent> {
  for (const e of events) yield e;
}

function seams(events: StreamedEvent[], extra: Partial<NotifierSeams> = {}) {
  const toasts: Toast[] = [];
  const errors: string[] = [];
  const s: NotifierSeams = {
    events: () => stream(events),
    ticketTitle: async () => 'Write the report',
    raise: async (t) => (toasts.push(t), true),
    sayError: (l) => errors.push(l),
    now: () => START,
    ...extra,
  };
  return { s, toasts, errors };
}

test('toastFor: only the two Needs You event types make a toast, titled "Magarine needs you", naming the ticket and the inbox\'s own line', () => {
  const decision = toastFor(ev('worker_needs_user_decision', { payload: { blockers: ['which platform?'] } }), 'Write the report');
  assert.equal(decision?.title, TOAST_TITLE);
  assert.match(decision!.body, /^Write the report\n/);
  assert.match(decision!.body, /which platform\?/);
  assert.ok(toastFor(ev('worker_needs_review', { payload: { summary: 'done, please look' } }), 'T')!.body.includes('done, please look'));

  const others = ['worker_done', 'worker_failed_final', 'worker_failed_retryable', 'adapter_unavailable', 'project_spend_cap_reached', 'project_not_ready', 'run_started', 'worker_progress', 'review_approved', 'user_decision'];
  for (const type of others) assert.equal(toastFor(ev(type), 'T'), null, `${type} must not toast`);
  assert.deepEqual([...TOAST_EVENT_TYPES].sort(), ['worker_needs_review', 'worker_needs_user_decision']);
});

test('the notifier raises exactly one toast per qualifying event and none for the rest of the stream', async () => {
  const { s, toasts } = seams([
    ev('worker_progress', {}, 1),
    ev('worker_needs_user_decision', { payload: { blockers: ['first-blocker'] } }, 2),
    ev('worker_done', {}, 3),
    ev('worker_needs_review', { payload: { summary: 'second-summary' } }, 4),
    ev('worker_failed_final', {}, 5),
  ]);
  await runNotifier(s, new AbortController().signal);
  assert.equal(toasts.length, 2);
  assert.match(toasts[0]!.body, /first-blocker/);
  assert.match(toasts[1]!.body, /second-summary/);
});

test('an item that was already waiting before the notifier started is not re-announced (it is in the inbox and the window title)', async () => {
  const { s, toasts } = seams([
    ev('worker_needs_review', { createdAt: '2026-09-20T11:59:00.000Z', payload: { summary: 'old-item' } }, 1),
    ev('worker_needs_review', { createdAt: '2026-09-20T12:00:01.000Z', payload: { summary: 'new-item' } }, 2),
  ]);
  await runNotifier(s, new AbortController().signal);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0]!.body, /new-item/);
});

test('a title that cannot be looked up falls back to the ticket id rather than dropping the toast', async () => {
  const { s, toasts } = seams([ev('worker_needs_review', { payload: { summary: 's' } })], {
    ticketTitle: async () => {
      throw new Error('board unreachable');
    },
  });
  await runNotifier(s, new AbortController().signal);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0]!.body, /^tkt_1\n/);
});

test('a stream that ends ends the notifier quietly; one that throws is said once and never crashes the host; a failed toast does not stop the next', async () => {
  const ended = seams([]);
  await runNotifier(ended.s, new AbortController().signal);
  assert.deepEqual(ended.errors, []);

  const boom = seams([], {
    events: () =>
      (async function* () {
        throw new Error('connection reset');
        yield ev('x');
      })(),
  });
  await runNotifier(boom.s, new AbortController().signal);
  assert.deepEqual(boom.errors, ['notifications stopped: connection reset']);

  let calls = 0;
  const flaky = seams([ev('worker_needs_review', { payload: { summary: 'one' } }, 1), ev('worker_needs_review', { payload: { summary: 'two' } }, 2)], {
    raise: async () => {
      calls++;
      if (calls === 1) throw new Error('powershell died');
      return true;
    },
  });
  await runNotifier(flaky.s, new AbortController().signal);
  assert.equal(calls, 2, 'the second toast was still attempted');
});

test('an aborted notifier stops and says nothing', async () => {
  const ac = new AbortController();
  const { s, toasts, errors } = seams([], {
    events: () =>
      (async function* () {
        ac.abort();
        yield ev('worker_needs_review', { payload: { summary: 'late' } });
      })(),
  });
  await runNotifier(s, ac.signal);
  assert.deepEqual([toasts.length, errors.length], [0, 0]);
});

// ---- the stdin-not-argv proof (the way token.test.ts proves it for the clipboard) ----

test('the toast text goes to PowerShell on STDIN and NEVER on the command line -- even text full of quotes, newlines and shell metacharacters', async () => {
  const calls: Array<{ args: string[]; input: string }> = [];
  const nasty = { title: TOAST_TITLE, body: 'Deploy "prod" $(whoami) `id` </text><toast launch="x"> \'; DROP\nsecond line ünïcode ✓' };
  await raiseToast(nasty, async (args, input) => (calls.push({ args, input }), { ok: true }));
  await raiseToast({ title: TOAST_TITLE, body: 'a different ticket title' }, async (args, input) => (calls.push({ args, input }), { ok: true }));

  assert.equal(calls.length, 2);
  for (const c of calls) {
    for (const arg of c.args) {
      assert.ok(!arg.includes('prod') && !arg.includes('whoami') && !arg.includes('different ticket'), `owner text leaked into argv: ${arg.slice(0, 40)}`);
    }
  }
  assert.deepEqual(calls[0]!.args, calls[1]!.args, 'the argument list is the same fixed list for every toast');
  assert.deepEqual(calls[0]!.args, TOAST_POWERSHELL_ARGS);
  assert.deepEqual(JSON.parse(calls[0]!.input), nasty, 'the text arrives intact on stdin as JSON');
});

test('the fixed script builds the toast through the XML DOM (no markup parsing of owner text) and has no launch action', () => {
  const script = Buffer.from(TOAST_POWERSHELL_ARGS[3]!, 'base64').toString('utf16le');
  assert.match(script, /InnerText = \[string\]\$d\.title/);
  assert.match(script, /InnerText = \[string\]\$d\.body/);
  assert.ok(!/launch=|activationType|protocol/i.test(script), 'a click must do nothing');
  assert.match(script, /WindowsPowerShell/, "the sender is Windows PowerShell's own identity");
});
