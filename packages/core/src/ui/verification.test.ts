// THE PAGE SAYS WHAT THE DAEMON NOW DOES BY ITSELF. Batch 18 Role B item 2
// (docs/strategy/batch-18-replan-owner-walk.md section 3), rulings 31-34.
//
// The owner: "there is no way to know what is happening in real time". Batch 18
// made the daemon verify every finished ticket and take Manager turns unasked;
// if the page does not say so, tickets sit still and a Manager acts with no
// explanation. Each test below drives a REAL daemon (src/ui/scriptedDaemon.ts:
// the real loop and request handler, the fake adapter) into the state, and reads
// what the page draws from real `GET /board` and `GET /activity` responses.
// There are no fixtures. What each line is derived from is in
// ui/ELEMENT-FIELD-TABLE.md.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { testTempRoot } from '../testSupport.ts';
import { discussProject } from '../manager.ts';
import { withScriptedDaemon, type ScriptedDaemon } from './scriptedDaemon.ts';
import { openPage } from './domHarness.ts';

const root = testTempRoot('ui-verification');
after(root.cleanup);

type OpenedPage = ReturnType<typeof openPage>;

const EMPTY_PROPOSAL = { kind: 'manager_proposal', proposal: { rationale: 'everything in the scope is delivered', commands: [] } } as const;

async function open(d: ScriptedDaemon): Promise<OpenedPage> {
  const page = openPage({ baseUrl: d.baseUrl, token: d.token });
  await page.waitFor(() => page.byId('projectSelect').children.length === 1, 'the project to reach the selector');
  return page;
}

async function pollUntil(page: OpenedPage, check: () => boolean, message: string, tries = 20): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await page.poll();
  }
  if (!check()) throw new Error(`the page never reached: ${message}`);
}

const lane = (page: OpenedPage, key: string) => page.byId('lanes').querySelector(`[data-lane="${key}"]`)!.textContent;

/** A real project where the owner has spoken to the Manager (so the Manager is engaged) and the Manager had nothing to add. */
function engageManager(d: ScriptedDaemon): string {
  const owner = discussProject(d.db, d.projectId, 'please build the thing');
  d.adapter.setScript(owner, EMPTY_PROPOSAL);
  return owner;
}

// -------------------------------------------------------------- REVIEW ----

test('a ticket a verifier is checking says "being verified", not its raw state name', async () => {
  await withScriptedDaemon(root, async (d) => {
    const work = d.addWorkTicket({ title: 'Write the parser' });
    d.adapter.setScript(work.id, { kind: 'succeed' });
    d.adapter.setScript(work.id, { kind: 'verify_hang' });   // the verifier is still looking

    await d.tickOnly();                                       // the worker finishes, the ticket enters REVIEW and its verifier starts, and does not end
    await d.waitForStatus(work.id, ['REVIEW'], 'REVIEW after the worker is done');

    const page = await open(d);
    await pollUntil(page, () => lane(page, 'review').includes('Write the parser'), 'the ticket in the Review lane');

    // The daemon really reports the raw state...
    const board = await (await fetch(`${d.baseUrl}/board?project=${d.projectId}`, { headers: { Authorization: `Bearer ${d.token}` } })).json() as any;
    assert.equal(board.tickets.find((t: any) => t.id === work.id).status, 'REVIEW');
    // ...and the page says what that means.
    assert.match(lane(page, 'review'), /Being verified/);
    assert.match(page.byId('listBody').textContent, /being verified/);
    assert.doesNotMatch(page.byId('listBody').textContent, /\bREVIEW\b/, 'the list shows the raw state name');
  });
});

// ----------------------------------------------------------- REJECTION ----

test('a rejected attempt shows the verifier\'s reason on its card while it waits to be retried', async () => {
  await withScriptedDaemon(root, async (d) => {
    const work = d.addWorkTicket({ title: 'Write the parser', criteria: ['it parses'], maxAttempts: 3 });
    d.adapter.setScript(work.id, { kind: 'succeed' });
    d.adapter.setScript(work.id, { kind: 'verify_fail', reason: 'parser.ts line 12 is a TODO stub' });

    await d.step();                                           // worker done -> REVIEW
    await d.step();                                           // verifier fails it -> back to READY, one attempt used
    await d.waitForStatus(work.id, ['READY'], 'READY after a rejection');

    const page = await open(d);
    await pollUntil(page, () => lane(page, 'waiting').includes('Write the parser'), 'the ticket in the Waiting lane');

    const reason = page.byId('lanes').querySelector('[data-role="rejection"]');
    assert.ok(reason, 'a rejected ticket\'s card carries no rejection line');
    assert.match(reason!.textContent, /Rejected/);
    assert.match(reason!.textContent, /parser\.ts line 12 is a TODO stub/, 'the verifier\'s evidence never reached the card');
  });
});

test('a ticket that ran out of attempts shows the verdict where its failure reason is', async () => {
  await withScriptedDaemon(root, async (d) => {
    const work = d.addWorkTicket({ title: 'Write the parser', criteria: ['it parses'], maxAttempts: 1 });
    d.adapter.setScript(work.id, { kind: 'succeed' });
    d.adapter.setScript(work.id, { kind: 'verify_fail', reason: 'no test covers the empty input' });

    await d.step();
    await d.step();
    await d.waitForStatus(work.id, ['FAILED'], 'FAILED after the last attempt was rejected');

    const page = await open(d);
    await pollUntil(page, () => lane(page, 'failed').includes('Write the parser'), 'the ticket in the Failed lane');

    const reason = page.byId('lanes').querySelector('[data-role="failure"]');
    assert.ok(reason, 'a failed ticket\'s card carries no reason');
    assert.match(reason!.textContent, /no test covers the empty input/);
  });
});

test('a ticket that passed on retry carries no stale rejection', async () => {
  await withScriptedDaemon(root, async (d) => {
    const work = d.addWorkTicket({ title: 'Write the parser', criteria: ['it parses'], maxAttempts: 3 });
    d.adapter.setScript(work.id, { kind: 'succeed' });
    d.adapter.setScript(work.id, { kind: 'verify_fail', reason: 'first try was a stub', times: 1 });

    for (let i = 0; i < 6 && d.tickets().find((t) => t.id === work.id)!.status !== 'DONE'; i++) await d.step();
    await d.waitForStatus(work.id, ['DONE'], 'DONE once the second verification passed');

    const page = await open(d);
    await pollUntil(page, () => lane(page, 'done').includes('Write the parser'), 'the ticket in the Done lane');
    assert.equal(page.byId('lanes').querySelector('[data-role="rejection"]'), null);
  });
});

// ----------------------------------------------------- THE MANAGER TURN ----

test('a Manager turn that is running says so in words, and an automatic one says it is automatic', async () => {
  await withScriptedDaemon(root, async (d) => {
    engageManager(d);
    const work = d.addWorkTicket({ title: 'Build the thing' });
    d.adapter.setScript(work.id, { kind: 'succeed' });
    d.adapter.setDefaultScript({ kind: 'hang' });             // the automatic turn, once it exists, keeps running

    for (let i = 0; i < 8 && !d.tickets().some((t) => t.automatic && t.status === 'IN_PROGRESS'); i++) {
      await d.tickOnly();
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.ok(d.tickets().some((t) => t.automatic && t.status === 'IN_PROGRESS'), 'the daemon never started an automatic Manager turn');

    const page = await open(d);
    await pollUntil(page, () => lane(page, 'active').includes('checking progress'), 'the running Manager turn');

    const board = await (await fetch(`${d.baseUrl}/board?project=${d.projectId}`, { headers: { Authorization: `Bearer ${d.token}` } })).json() as any;
    const auto = board.tickets.find((t: any) => t.automatic === true);
    assert.equal(auto.kind, 'manager');
    assert.equal(auto.title, 'Manager: review progress');

    assert.match(lane(page, 'active'), /Manager is checking progress on its own/);
    assert.match(lane(page, 'active'), /Manager · automatic/);
    assert.match(page.byId('fleetList').textContent, /Manager \(automatic\)/);
    assert.match(page.byId('fleetList').textContent, /Manager is checking progress on its own/);
    // A state that ruling 33 made impossible is never described.
    assert.doesNotMatch(page.byId('lanes').textContent + page.byId('fleetList').textContent, /waiting for a slot/i);
  });
});

test('a Manager turn the owner asked for does not read as an automatic one', async () => {
  await withScriptedDaemon(root, async (d) => {
    const turn = discussProject(d.db, d.projectId, 'what should we do next?');
    d.adapter.setScript(turn, { kind: 'hang' });
    await d.tickOnly();
    await d.waitForStatus(turn, ['IN_PROGRESS'], 'the Manager turn running');

    const page = await open(d);
    await pollUntil(page, () => lane(page, 'active').includes('Manager is'), 'the running Manager turn');

    assert.match(lane(page, 'active'), /Manager is working on what you asked/);
    assert.doesNotMatch(lane(page, 'active'), /on its own|automatic/i, 'a manual turn is shown as an automatic one');
    assert.doesNotMatch(page.byId('fleetList').textContent, /automatic/i);
  });
});

// ----------------------------------------------------------- SCOPE MET ----

test('"Scope met" shows when an automatic Manager turn finished with nothing left to propose', async () => {
  await withScriptedDaemon(root, async (d) => {
    engageManager(d);
    const work = d.addWorkTicket({ title: 'Build the thing' });
    d.adapter.setScript(work.id, { kind: 'succeed' });
    d.adapter.setDefaultScript(EMPTY_PROPOSAL);

    for (let i = 0; i < 12 && !d.tickets().some((t) => t.automatic && t.status === 'DONE'); i++) await d.step();
    assert.ok(d.tickets().some((t) => t.automatic && t.status === 'DONE'), 'the automatic turn never finished');

    const page = await open(d);
    await pollUntil(page, () => page.text('boardStatus').includes('Scope met'), 'the scope-met line');

    assert.equal(page.byId('boardStatus').hidden, false);
    assert.match(page.text('boardStatus'), /everything in the scope is delivered/);
    const card = page.byId('lanes').querySelector('[data-role="scope-met"]');
    assert.ok(card, 'the automatic turn\'s own card does not say the scope is met');
    assert.match(card!.textContent, /everything in the scope is delivered/);
  });
});

test('"Scope met" is not claimed when the automatic turn proposed more work', async () => {
  await withScriptedDaemon(root, async (d) => {
    engageManager(d);
    const work = d.addWorkTicket({ title: 'Build the thing' });
    d.adapter.setScript(work.id, { kind: 'succeed' });
    d.adapter.setDefaultScript({
      kind: 'manager_proposal',
      proposal: {
        rationale: 'the tests are still missing',
        commands: [{ type: 'create_ticket', title: 'Write the tests', description: 'cover the parser', acceptance_criteria: ['tests pass'] }],
      },
    });

    for (let i = 0; i < 12 && !d.tickets().some((t) => t.automatic && t.status === 'DONE'); i++) await d.step();
    assert.ok(d.tickets().some((t) => t.automatic && t.status === 'DONE'), 'the automatic turn never finished (its proposal may be malformed)');
    assert.ok(d.tickets().some((t) => t.title === 'Write the tests'), 'the proposal did not create its ticket');

    const page = await open(d);
    await pollUntil(page, () => page.text('boardCount').includes('tickets'), 'the board');
    assert.equal(page.text('boardStatus'), '');
    assert.equal(page.byId('lanes').querySelector('[data-role="scope-met"]'), null);
  });
});
