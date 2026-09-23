// STEERING FROM THE WINDOW. Batch 19 mini-phase 3B, ruling 39
// (docs/strategy/batch-19-item-3b-steering-from-the-window.md).
//
// Three things the page can now change: the answer to each of a Manager's
// questions, the machine's and the project's settings, and the scope document.
// Every test drives a REAL daemon (src/ui/scriptedDaemon.ts: the real loop and
// request handler over a real sqlite file, the fake adapter) through the real
// ui/app.js, and checks the result with the daemon's own reads. There are no
// fixtures. Where a test needs a daemon refusal it causes a real one and then
// asks the daemon for the same refusal directly, so "verbatim" is checked
// against the daemon's words, not against a copy of them written here.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testTempRoot } from '../testSupport.ts';
import { discussProject } from '../manager.ts';
import { createProject, listEventsForEntity, setProjectScopePath } from '../store.ts';
import { withScriptedDaemon, type ScriptedDaemon } from './scriptedDaemon.ts';
import { withDaemon } from './testDaemon.ts';
import { openPage, type PageOptions } from './domHarness.ts';
import { UI_DIR } from './page.ts';

const root = testTempRoot('ui-steering');
after(root.cleanup);

type OpenedPage = ReturnType<typeof openPage>;
type El = OpenedPage['document']['body'];

async function open(d: ScriptedDaemon, extra: Partial<PageOptions> = {}): Promise<OpenedPage> {
  const page = openPage({ baseUrl: d.baseUrl, token: d.token, ...extra });
  await page.waitFor(() => page.byId('projectSelect').children.length === 1, 'the project to reach the selector');
  return page;
}

async function pollUntil(page: OpenedPage, check: () => boolean, message: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await page.poll();
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!check()) throw new Error(`the page never reached: ${message}`);
}

async function call(d: ScriptedDaemon, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${d.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${d.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function byClass(node: El, cls: string): El[] {
  const out: El[] = [];
  for (const c of node.children) {
    if (c.className.split(' ').includes(cls)) out.push(c);
    out.push(...byClass(c, cls));
  }
  return out;
}
const buttonNamed = (node: El, text: string) => node.querySelectorAll('button').find((b) => b.textContent === text)!;

const QUESTIONS = ['Which library?', 'Which host?', 'Which region?'];

/** A real Manager turn that asked the owner `questions`, in order, and is BLOCKED on them. */
async function managerAsking(d: ScriptedDaemon, questions: string[]): Promise<string> {
  const turn = discussProject(d.db, d.projectId, 'please build the thing');
  d.adapter.setScript(turn, {
    kind: 'manager_proposal',
    proposal: { rationale: 'need to ask', commands: questions.map((q) => ({ type: 'request_user_decision', question: q, context: 'ctx' })) },
  });
  await d.step();
  await d.waitForStatus(turn, ['BLOCKED'], 'the Manager turn asking');
  return turn;
}

const needsRow = (page: OpenedPage) => byClass(page.byId('needsList'), 'ask')[0] ?? null;
const answerInputs = (page: OpenedPage) => byClass(needsRow(page)!, 'answer').map((l) => l.querySelector('input')!);

// ------------------------------------------------------ acceptance 1 ----

test('three pending questions draw three labelled fields and one submit; answering sends them in order and the ticket unblocks', async () => {
  await withScriptedDaemon(root, async (d) => {
    const turn = await managerAsking(d, QUESTIONS);
    const inbox = (await call(d, 'GET', `/inbox?project=${d.projectId}`)).json;
    const item = inbox.find((i: any) => i.ticketId === turn);
    assert.equal(item.questions.length, 3, 'the daemon did not list three questions');

    const page = await open(d);
    await pollUntil(page, () => needsRow(page) !== null && byClass(needsRow(page)!, 'answer').length === 3, 'three answer fields');
    const labels = byClass(needsRow(page)!, 'q').map((q) => q.textContent);
    assert.deepEqual(labels, item.questions, 'the labels are not the daemon\'s questions, in order');
    assert.equal(needsRow(page)!.querySelectorAll('button').filter((b) => b.textContent === 'Answer').length, 1, 'not exactly one submit');

    const inputs = answerInputs(page);
    ['lodash', 'fly.io', 'eu-west'].forEach((v, i) => { inputs[i].value = v; });
    buttonNamed(needsRow(page)!, 'Answer').click();
    await d.waitForStatus(turn, ['READY'], 'the Manager turn unblocked');

    const decision = listEventsForEntity(d.db, 'ticket', turn).filter((e) => e.eventType === 'user_decision').at(-1)!;
    const pairs = (decision.payload as { decisions: { question: string; answer: string }[] }).decisions;
    assert.deepEqual(pairs.map((p) => p.answer), ['lodash', 'fly.io', 'eu-west']);
    assert.deepEqual(pairs.map((p) => p.question), item.questions, 'the answers were paired with the wrong questions');
    await pollUntil(page, () => needsRow(page) === null, 'the answered item to leave Needs you');
    const waiting = page.byId('lanes').querySelector('[data-lane="waiting"]')!.textContent;
    assert.match(waiting, /Manager/, 'the board does not show the unblocked Manager turn waiting');
  });
});

// ------------------------------------------------------ acceptance 2 ----

test('typing in field 2 of 3 survives two polls, and survives the row being rebuilt under it', async () => {
  await withScriptedDaemon(root, async (d) => {
    await managerAsking(d, QUESTIONS);
    // The one rewrite in this test: a suffix on the inbox message, switched on
    // after the typing, so the row's own data changes and the row IS rebuilt.
    let suffix = '';
    const page = await open(d, {
      rewriteJson: (path, body) => (path === '/inbox' && Array.isArray(body)
        ? body.map((i: any) => ({ ...i, message: i.message + suffix })) : body),
    });
    await pollUntil(page, () => needsRow(page) !== null && answerInputs(page).length === 3, 'three answer fields');

    const first = needsRow(page);
    answerInputs(page)[1].value = 'half an answer';
    answerInputs(page)[1].focus();
    await page.poll();
    await page.poll();
    assert.equal(needsRow(page), first, 'an unchanged row was rebuilt by the poll');
    assert.equal(answerInputs(page)[1].value, 'half an answer', 'two polls threw the draft away');

    answerInputs(page)[0].value = 'one';
    answerInputs(page)[2].value = 'three';
    suffix = ' [edited]';
    await pollUntil(page, () => needsRow(page) !== first, 'the row to be rebuilt after its own data changed');
    assert.deepEqual(answerInputs(page).map((n) => n.value), ['one', 'half an answer', 'three'], 'a rebuild lost a draft');
    assert.equal(page.document.activeElement, answerInputs(page)[1], 'a rebuild lost the focus');
  });
});

// ------------------------------------------------------ acceptance 3 ----

test('a refused answer shows the daemon\'s own sentence and clears no field', async () => {
  await withScriptedDaemon(root, async (d) => {
    const turn = await managerAsking(d, QUESTIONS);
    const page = await open(d);
    await pollUntil(page, () => needsRow(page) !== null && answerInputs(page).length === 3, 'three answer fields');

    answerInputs(page)[0].value = 'first';
    answerInputs(page)[2].value = 'third';                      // question 2 left empty: only two real answers
    buttonNamed(needsRow(page)!, 'Answer').click();
    await page.waitFor(() => byClass(needsRow(page)!, 'roster-error').length === 1, 'the refusal to show');

    const refusal = await call(d, 'POST', `/tickets/${turn}/decide`, { answers: ['first', '', 'third'] });
    assert.equal(refusal.status, 400);
    assert.equal(byClass(needsRow(page)!, 'roster-error')[0].textContent, refusal.json.error, 'the page reworded the daemon\'s sentence');
    assert.equal(byClass(needsRow(page)!, 'roster-error')[0].getAttribute('role'), 'alert', 'a screen reader is not told of the refusal');
    assert.deepEqual(answerInputs(page).map((n) => n.value), ['first', '', 'third'], 'a refusal cleared a field');
    await page.poll();
    assert.deepEqual(answerInputs(page).map((n) => n.value), ['first', '', 'third'], 'the next poll cleared a field');
    assert.equal((await call(d, 'GET', `/board?project=${d.projectId}`)).json.tickets.find((t: any) => t.id === turn).status, 'BLOCKED');
  });
});

// ------------------------------------------------------ acceptance 4 ----

test('a ticket with one question is exactly as before: one field, one button, sending one answer', async () => {
  await withScriptedDaemon(root, async (d) => {
    const work = d.addWorkTicket({ title: 'Ask once' });
    d.adapter.setScript(work.id, { kind: 'needs_user_decision', blockers: ['Tabs or spaces?'] });
    await d.step();
    await d.waitForStatus(work.id, ['BLOCKED'], 'the work ticket asking');

    const page = await open(d);
    await pollUntil(page, () => needsRow(page) !== null, 'the Needs-you item');
    assert.equal(byClass(needsRow(page)!, 'answers').length, 0, 'a one-question ticket got the multi-field form');
    const inputs = needsRow(page)!.querySelectorAll('input');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].getAttribute('aria-label'), 'your answer', 'the single field is not the one it was before');
    inputs[0].value = 'spaces';
    buttonNamed(needsRow(page)!, 'Answer').click();
    await d.waitForStatus(work.id, ['READY'], 'the work ticket unblocked');
    const decision = listEventsForEntity(d.db, 'ticket', work.id).filter((e) => e.eventType === 'user_decision').at(-1)!;
    assert.equal((decision.payload as { answer: string }).answer, 'spaces');
    assert.equal((decision.payload as { decisions: unknown[] }).decisions.length, 1);
  });
});

test('a Manager turn with exactly one listed question also gets the single field, sending one answer', async () => {
  // The work ticket above lists no questions at all; this one lists exactly
  // one, which is the other way to be "one question".
  await withScriptedDaemon(root, async (d) => {
    const turn = await managerAsking(d, ['Only this?']);
    const item = (await call(d, 'GET', `/inbox?project=${d.projectId}`)).json.find((i: any) => i.ticketId === turn);
    assert.equal(item.questions.length, 1);
    const page = await open(d);
    await pollUntil(page, () => needsRow(page) !== null, 'the Needs-you item');
    assert.equal(byClass(needsRow(page)!, 'answers').length, 0, 'one listed question got the multi-field form');
    const inputs = needsRow(page)!.querySelectorAll('input');
    assert.equal(inputs.length, 1);
    inputs[0].value = 'yes';
    buttonNamed(needsRow(page)!, 'Answer').click();
    await d.waitForStatus(turn, ['READY'], 'the Manager turn unblocked');
    const decision = listEventsForEntity(d.db, 'ticket', turn).filter((e) => e.eventType === 'user_decision').at(-1)!;
    assert.equal((decision.payload as { answer: string }).answer, 'yes');
  });
});

// ------------------------------------------------------ settings ----

async function openSettings(page: OpenedPage): Promise<void> {
  page.byId('settingsToggle').click();
  await page.settle();                                        // the panel's own reads, not a poll
  await page.waitFor(() => page.byId('machineManagerModel').children.length > 1 && page.byId('projectDefaultModel').children.length > 0,
    'the settings panel to fill');
}

test('changing the machine cap persists, and the panel shows the daemon\'s own read of it', async () => {
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d);
    await openSettings(page);
    assert.equal(page.byId('machineCap').value, '', 'a cap nobody set is shown as a value');
    assert.equal(page.byId('machineManagerModel').value, '', 'an unset Manager model is shown as set');
    await page.waitFor(() => page.text('capNote') !== '', 'the cap line');
    assert.equal(page.text('capNote'),
      'This daemon was started with --max-parallel 2, which wins until it is restarted. In force: 2. Saved: nothing.');

    page.byId('machineCap').value = ' 3 ';
    page.byId('saveMachine').click();
    await page.waitFor(() => !page.byId('machineSaved').hidden, 'the save to land');
    assert.equal((await call(d, 'GET', '/settings')).json.max_parallel_workers, '3');
    assert.equal(page.byId('machineCap').value, '3', 'the panel shows what was typed, not what the daemon stored');
    // This daemon runs with a machine cap flag of 2 (scriptedDaemon.ts), which
    // store.ts's resolveMachineCap returns before it reads the setting. So the
    // saved 3 is not in force, and the line says so with both numbers.
    const board = (await call(d, 'GET', `/board?project=${d.projectId}`)).json;
    assert.deepEqual([board.slots.cap, board.slots.capFlag], [2, 2], 'this test needs a daemon whose flag wins');
    await page.waitFor(() => page.text('capNote').endsWith('Saved: 3.'), 'the cap line to show the saved value');
    assert.equal(page.text('capNote'),
      'This daemon was started with --max-parallel 2, which wins until it is restarted. In force: 2. Saved: 3.');

    // The poll never refills the panel; closing and opening it reads again.
    page.byId('machineCap').value = '7';
    await page.poll();
    assert.equal(page.byId('machineCap').value, '7', 'the poll overwrote a value being edited');
    page.byId('settingsToggle').click();
    page.byId('settingsToggle').click();
    await page.waitFor(() => page.byId('machineCap').value === '3', 'reopening to show the daemon\'s own read, not the 7 left in the field');
  });
});

test('with no flag in force, a saved cap is the cap in force and the line is the plain sentence', async () => {
  // A real `magarine serve` started without --max-parallel: the setting IS
  // the cap, from the next read, with no restart.
  await withDaemon(root, async (d) => {
    const p = await d.createProject('Capped');
    const page = openPage({ baseUrl: d.baseUrl, token: d.token });
    await page.waitFor(() => page.byId('projectSelect').children.length === 1, 'the project');
    await openSettings(page);
    await page.waitFor(() => page.text('capNote') !== '', 'the cap line');
    assert.equal(page.text('capNote'), 'Applies on the next tick, with no restart.');

    page.byId('machineCap').value = '4';
    page.byId('saveMachine').click();
    await page.waitFor(() => !page.byId('machineSaved').hidden, 'the save to land');
    await page.settle();
    const board = await (await fetch(`${d.baseUrl}/board?project=${p.id}`, { headers: { Authorization: `Bearer ${d.token}` } })).json() as any;
    assert.equal(board.slots.cap, 4, 'the saved cap is not the cap in force');
    assert.equal(page.text('capNote'), 'Applies on the next tick, with no restart.', 'a daemon with no flag was said to have one');
  });
});

test('--max-parallel 1 with nothing saved says the flag wins, which the cap alone could not tell apart from the fallback', async () => {
  // The case inference got wrong: no setting saved, cap in force 1 -- the
  // same numbers the fallback gives. Only the daemon's own capFlag says so.
  await withDaemon(root, async (d) => {
    await d.createProject('Flagged');
    const page = openPage({ baseUrl: d.baseUrl, token: d.token });
    await page.waitFor(() => page.byId('projectSelect').children.length === 1, 'the project');
    await openSettings(page);
    await page.waitFor(() => page.text('capNote') !== '', 'the cap line');
    assert.equal(page.text('capNote'),
      'This daemon was started with --max-parallel 1, which wins until it is restarted. In force: 1. Saved: nothing.');
  }, ['--max-parallel', '1']);
});

test('a cap the browser could not read is refused with a sentence and sends nothing; a cleared cap still unsets', async () => {
  // Review finding (Medium). A number input holding "3-" reports value === ''
  // -- the same as a cleared field -- and '' is sent as null, which unsets the
  // saved cap. The browser's own validity.badInput tells the two apart. This
  // harness input does not parse, so the browser's report is set by hand
  // here; src/ui/browser.test.ts types "3-" into real Chrome.
  await withScriptedDaemon(root, async (d) => {
    await call(d, 'PATCH', '/settings', { max_parallel_workers: '3' });
    const page = await open(d);
    await openSettings(page);
    await page.waitFor(() => page.byId('machineCap').value === '3', 'the saved cap');

    const requestsBefore = page.requests.length;
    page.byId('machineCap').value = '';
    (page.byId('machineCap') as any).validity = { badInput: true };
    page.byId('saveMachine').click();
    await page.settle();
    assert.equal(page.requests.slice(requestsBefore).filter((p) => p === '/settings').length, 0, 'an unreadable cap was sent');
    assert.equal((await call(d, 'GET', '/settings')).json.max_parallel_workers, '3', 'an unreadable cap unset the saved one');
    assert.equal(page.text('machineError'),
      'The worker cap is not a number this page can read, so nothing was saved. Clear the field to unset it, or type a whole number.');
    assert.equal(page.byId('machineSaved').hidden, true);

    (page.byId('machineCap') as any).validity = { badInput: false };   // cleared on purpose
    page.byId('saveMachine').click();
    await page.waitFor(() => !page.byId('machineSaved').hidden, 'the deliberate clear to save');
    assert.equal((await call(d, 'GET', '/settings')).json.max_parallel_workers, undefined, 'a deliberately cleared cap did not unset');
  });
});

test('a settings read that fails during a poll says the daemon did not answer, and is not an unhandled rejection', async () => {
  // Review finding (Medium). While the panel is open each pass re-reads
  // /settings for the cap line; the daemon never fails that read, so the
  // harness's named `refuse` answers it with a 500.
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d, { refuse: { path: '/settings', status: 500, error: 'the settings table is locked' } });
    page.byId('settingsToggle').click();
    await page.settle();
    await page.poll();
    assert.match(page.text('notices'), /the daemon did not answer/, 'the failed read left no notice');
    assert.match(page.text('notices'), /the settings table is locked/);
  });
});

test('a project override set and then set back to "use the machine default" is cleared to null, as a re-read shows', async () => {
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d);
    await openSettings(page);
    const models = (await call(d, 'GET', '/models')).json as string[];
    const project = () => call(d, 'GET', '/projects').then((r) => r.json.find((p: any) => p.id === d.projectId));
    assert.equal(page.byId('projectManagerModel').value, '', 'no override is shown as "use the machine default"');
    assert.equal(page.byId('projectManagerModel').children[0].textContent, 'use the machine default');
    // The scripted project is created with its own cap of 2, so it starts set.
    assert.equal((await project()).maxParallelWorkers, 2);
    assert.equal((page.byId('projectCapDefault') as any).checked, false);
    assert.equal(page.byId('projectCap').value, '2');

    page.byId('projectManagerModel').value = models[1];
    page.byId('projectCap').value = '3';
    page.byId('saveProject').click();
    await page.waitFor(() => !page.byId('projectSaved').hidden, 'the save to land');
    assert.equal((await project()).managerModel, models[1]);
    assert.equal((await project()).maxParallelWorkers, 3);

    page.byId('projectManagerModel').value = '';
    (page.byId('projectCapDefault') as any).checked = true;
    page.byId('saveProject').click();
    await page.settle();                                        // the PATCH, and the refill from its answer
    assert.equal((await project()).managerModel, null, 'choosing the machine default did not send null');
    assert.equal((await project()).maxParallelWorkers, null, 'the cap checkbox did not send null');
    assert.equal((page.byId('projectCapDefault') as any).checked, true);
  });
});

test('an invalid value shows the daemon\'s own sentence and changes nothing', async () => {
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d);
    await openSettings(page);
    const before = (await call(d, 'GET', '/settings')).json;

    page.byId('machineCap').value = '0';
    page.byId('saveMachine').click();
    await page.waitFor(() => !page.byId('machineError').hidden, 'the machine refusal to show');
    const refusal = await call(d, 'PATCH', '/settings', { default_manager_model: null, default_verifier_model: null, max_parallel_workers: '0' });
    assert.equal(refusal.status, 400);
    assert.equal(page.text('machineError'), refusal.json.error, 'the page reworded the daemon\'s sentence');
    assert.deepEqual((await call(d, 'GET', '/settings')).json, before, 'a refused save changed a setting');
    assert.equal(page.byId('machineCap').value, '0', 'the refusal cleared the field');
    assert.equal(page.byId('machineSaved').hidden, true);

    const projectBefore = (await call(d, 'GET', '/projects')).json.find((p: any) => p.id === d.projectId);
    page.byId('projectCap').value = 'lots';
    page.byId('saveProject').click();
    await page.waitFor(() => !page.byId('projectError').hidden, 'the project refusal to show');
    const project = (await call(d, 'GET', '/projects')).json.find((p: any) => p.id === d.projectId);
    const projRefusal = await call(d, 'PATCH', `/projects/${d.projectId}`, {
      defaultModel: project.defaultModel, managerModel: null, verifierModel: null, maxParallel: 'lots',
    });
    assert.equal(page.text('projectError'), projRefusal.json.error);
    assert.deepEqual(project, projectBefore, 'a refused save changed the project');
    assert.equal(page.byId('projectCap').value, 'lots', 'the refusal cleared the field');
  });
});

// ------------------------------------------------------ the scope editor ----

function scoped(d: ScriptedDaemon, text: string): string {
  const dir = join(root.root, `scope-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  const file = join(dir, 'SCOPE.md');
  writeFileSync(file, text);
  setProjectScopePath(d.db, d.projectId, file);
  return file;
}

const scopeEvents = (d: ScriptedDaemon) => listEventsForEntity(d.db, 'project', d.projectId).filter((e) => e.eventType === 'scope_updated').length;

async function openScope(page: OpenedPage, expect: string): Promise<void> {
  await pollUntil(page, () => page.text('scopeText').includes(expect), 'the scope text');
  page.byId('scopeToggle').click();
}

test('editing the scope and saving replaces the document; cancelling sends nothing; a poll while editing does not touch the draft', async () => {
  await withScriptedDaemon(root, async (d) => {
    const file = scoped(d, '# Recipes\n\nKeep recipes.\n');
    const page = await open(d);
    await openScope(page, 'Keep recipes.');

    page.byId('scopeEdit').click();
    assert.equal(page.byId('scopeEditor').hidden, false);
    assert.equal(page.byId('scopeDraft').value, '# Recipes\n\nKeep recipes.\n', 'the editor did not start from the current text');
    page.byId('scopeDraft').value = '# Recipes\n\nKeep recipes, and';
    await page.poll();
    await page.poll();
    assert.equal(page.byId('scopeDraft').value, '# Recipes\n\nKeep recipes, and', 'a poll touched the draft');

    page.byId('scopeCancel').click();
    assert.equal(page.byId('scopeEditor').hidden, true);
    await page.settle();
    assert.equal(readFileSync(file, 'utf8'), '# Recipes\n\nKeep recipes.\n', 'Cancel wrote the file');
    assert.equal(scopeEvents(d), 0, 'Cancel sent a write');

    page.byId('scopeEdit').click();
    page.byId('scopeDraft').value = '# Recipes\n\nKeep recipes and plan meals.\n';
    page.byId('scopeSave').click();
    await page.waitFor(() => page.byId('scopeEditor').hidden, 'the editor to close after a save');
    assert.equal(readFileSync(file, 'utf8'), '# Recipes\n\nKeep recipes and plan meals.\n');
    assert.equal(scopeEvents(d), 1);
    assert.equal(page.text('scopeText'), '# Recipes\n\nKeep recipes and plan meals.\n', 'the view does not show what the daemon wrote');
  });
});

test('a scope changed on disk while it is being edited warns, with both lengths, before overwriting', async () => {
  await withScriptedDaemon(root, async (d) => {
    const file = scoped(d, 'v1\n');
    const page = await open(d);
    await openScope(page, 'v1');
    page.byId('scopeEdit').click();
    page.byId('scopeDraft').value = 'mine\n';

    writeFileSync(file, 'someone else wrote this\n');
    await pollUntil(page, () => page.text('scopeText').includes('someone else'), 'the view behind the editor to update');
    assert.equal(page.byId('scopeDraft').value, 'mine\n', 'a re-read of a changed file touched the draft');

    page.byId('scopeSave').click();
    await page.waitFor(() => !page.byId('scopeWarn').hidden, 'the warning');
    assert.equal(page.text('scopeWarn'),
      'The scope file changed since you began editing: it is now 24 characters, your draft is 5. Save again to overwrite it.');
    assert.equal(readFileSync(file, 'utf8'), 'someone else wrote this\n', 'the first Save overwrote a file that had changed');
    assert.equal(page.byId('scopeEditor').hidden, false);

    page.byId('scopeSave').click();
    await page.waitFor(() => page.byId('scopeEditor').hidden, 'the confirmed save');
    assert.equal(readFileSync(file, 'utf8'), 'mine\n');
  });
});

test('a scope save still in flight when the project changes is not drawn into the new project\'s view', async () => {
  // Review finding (Low). The write goes to the project it was made for; its
  // answer must not land in the view of the project the owner switched to.
  // The harness holds the PUT's real answer back, so it lands last, as a slow
  // disk would make it.
  await withScriptedDaemon(root, async (d) => {
    const fileA = scoped(d, 'scope of A\n');
    const b = createProject(d.db, { name: 'B', maxParallelWorkers: 2 });
    const dirB = join(root.root, `scope-b-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dirB);
    writeFileSync(join(dirB, 'SCOPE.md'), 'scope of B\n');
    setProjectScopePath(d.db, b.id, join(dirB, 'SCOPE.md'));

    const page = openPage({ baseUrl: d.baseUrl, token: d.token, delay: { path: `/projects/${d.projectId}/scope`, method: 'PUT', ms: 400 } });
    await page.waitFor(() => page.byId('projectSelect').children.length === 2, 'both projects');
    page.byId('projectSelect').value = d.projectId;
    page.byId('projectSelect').dispatch('change');
    await openScope(page, 'scope of A');
    page.byId('scopeEdit').click();
    page.byId('scopeDraft').value = 'draft for A\n';
    page.byId('scopeSave').click();
    for (let i = 0; i < 400 && readFileSync(fileA, 'utf8') !== 'draft for A\n'; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(readFileSync(fileA, 'utf8'), 'draft for A\n', 'the save never reached project A');

    page.byId('projectSelect').value = b.id;                      // while the PUT's answer is still held back
    page.byId('projectSelect').dispatch('change');
    await page.settle();
    assert.equal(page.text('scopeText'), 'scope of B\n', 'project A\'s saved text was drawn in project B\'s view');
  });
});

test('a project with no scope path is refused in the daemon\'s words; an unreadable scope offers no Edit', async () => {
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d);
    await pollUntil(page, () => page.text('scopeText') === '(this project has no scope file yet)', 'the absent sentence');
    page.byId('scopeToggle').click();
    assert.equal(page.byId('scopeEdit').hidden, false, 'the missing case must still be offered');
    page.byId('scopeEdit').click();
    page.byId('scopeDraft').value = 'a new scope';
    page.byId('scopeSave').click();
    await page.waitFor(() => !page.byId('scopeSaveError').hidden, 'the refusal');
    const refusal = await call(d, 'PUT', `/projects/${d.projectId}/scope`, { scopeText: 'a new scope' });
    assert.equal(refusal.status, 400);
    assert.equal(page.text('scopeSaveError'), refusal.json.error);
    assert.equal(page.byId('scopeDraft').value, 'a new scope', 'the refusal cleared the draft');
    page.byId('scopeCancel').click();

    const dir = join(root.root, `scope-dir-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir);
    setProjectScopePath(d.db, d.projectId, dir);                // a directory: exists, cannot be read
    await pollUntil(page, () => page.text('scopeText').includes('could not be read'), 'the unreadable sentence');
    assert.equal(page.byId('scopeEdit').hidden, true, 'an unreadable scope offers Edit');
  });
});

// ------------------------------------------------------ acceptance 10 ----

test('ELEMENT-FIELD-TABLE.md covers every element ruling 39 adds, and every sentence the page writes for it', () => {
  const table = readFileSync(join(UI_DIR, 'ELEMENT-FIELD-TABLE.md'), 'utf8');
  const app = readFileSync(join(UI_DIR, 'app.js'), 'utf8');
  const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
  for (const route of ['`GET /settings`, `PATCH /settings`', '`PATCH /projects/{id}`', '`PUT /projects/{id}/scope`']) {
    assert.ok(table.includes(`| ${route} |`), `the routes list does not name ${route}`);
  }
  for (const element of ['one answer field per question', 'answer refusal', '"Edit"', 'editor draft', '"Save"',
    'changed-on-disk warning', '"Cancel"', 'after a save', 'scope save refusal', 'Manager default model select',
    'verifier default model select', 'worker cap input', 'cap note:', 'cap note when a flag wins', 'project default model select',
    'project Manager model select', 'project verifier model select', 'project cap input',
    'project cap "use the machine default" checkbox', 'saved line', 'settings refusal']) {
    assert.ok(table.includes(`| ${element}`), `the table has no row for "${element}"`);
  }
  for (const copy of ['use the machine default', 'Saved. Showing what the daemon now reports.',
    'Save again to overwrite it.', 'Applies on the next tick, with no restart.', ', which wins until it is restarted. ']) {
    assert.ok(app.includes(copy) || html.includes(copy), `the page no longer writes "${copy}" -- update this test and the table together`);
    assert.ok(table.includes(copy), `the page writes "${copy}" and the table does not list it`);
  }
  assert.ok(app.includes("'not set \\u2014 each project\\u2019s own default model'"));
  assert.ok(table.includes('not set — each project\'s own default model'));
});
