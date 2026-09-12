import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classify, hasPolicyRow } from './policy.ts';

// Drives the completeness check off `stateMachine.ts`'s own `TransitionEvent`
// union rather than a hand-copied list, per this role's brief: a future
// transition added to that union without a matching policy row here must
// fail the build by itself. Part 1 is not permitted to edit stateMachine.ts
// (another engineer is adding transitions to it in parallel), so this reads
// the union directly out of the file's source text instead of importing a
// runtime export -- there isn't one, and adding one is exactly the edit
// that's off limits this batch. The union is a plain list of string-literal
// members (`| 'foo'`), which is stable enough to parse without needing the
// TypeScript compiler.
function transitionEventsFromStateMachineSource(): string[] {
  const path = fileURLToPath(new URL('./stateMachine.ts', import.meta.url));
  const source = readFileSync(path, 'utf8');

  const unionMatch = source.match(/export type TransitionEvent =\s*([\s\S]*?);/);
  assert.ok(unionMatch, 'could not find "export type TransitionEvent = ..." in stateMachine.ts');

  const members = [...unionMatch![1].matchAll(/'([a-zA-Z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(members.length > 0, 'parsed zero members out of the TransitionEvent union -- parsing broke');
  return members;
}

test('every event type the state machine can emit has a policy row', () => {
  const transitionEvents = transitionEventsFromStateMachineSource();
  const missing = transitionEvents.filter((eventType) => !hasPolicyRow(eventType));

  assert.deepEqual(
    missing,
    [],
    `policy.ts has no row for: ${missing.join(', ')}. Add one (or an explicit ` +
      `"document is silent" default) before this can pass -- do not weaken this test instead.`
  );
});

test('classify() returns a concrete policy for every transition event, not the silent fallback by accident', () => {
  const transitionEvents = transitionEventsFromStateMachineSource();
  for (const eventType of transitionEvents) {
    const policy = classify(eventType);
    assert.ok(policy.visibility, `classify('${eventType}') returned no visibility`);
    assert.equal(typeof policy.requiresUser, 'boolean', `classify('${eventType}') returned no requiresUser`);
  }
});

test('classify() is total: an unrecognized event type falls back to silent-internal rather than throwing', () => {
  const policy = classify('some_future_event_nobody_has_written_yet');
  assert.deepEqual(policy, { visibility: 'internal', requiresUser: false });
});

test('spot checks against the architecture document\'s explicit rows', () => {
  assert.deepEqual(classify('worker_needs_user_decision'), { visibility: 'inbox', requiresUser: true });
  assert.deepEqual(classify('worker_needs_review'), { visibility: 'inbox', requiresUser: true });
  assert.deepEqual(classify('worker_done'), { visibility: 'activity', requiresUser: false });
  assert.deepEqual(classify('worker_progress'), { visibility: 'internal', requiresUser: false });
  assert.deepEqual(classify('user_decision'), { visibility: 'activity', requiresUser: false });
});
