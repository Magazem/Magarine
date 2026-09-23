// WHAT IS IT RUNNING. Batch 19 mini-phase 4, the page half of ruling 40
// (docs/strategy/batch-19-item-4-drill-down.md, sections 5 and 6 included).
//
// The owner: "one worker is running PowerShell, what exactly, is it stuck".
// The command a worker runs is the likeliest place in this system for a
// secret, so the daemon holds it in memory only and forgets it when the run
// settles. These tests hold the page to the same rule and to the ruling's
// other half: the page states a measurement, never a verdict.
//
// Every test drives a REAL daemon (src/ui/scriptedDaemon.ts: the real loop,
// the real request handler, the fake adapter's real live channel) and reads
// what the page draws from real `GET /tickets/{id}/progress` and
// `GET /runs/{id}/live` answers. There are no fixtures.
//
// WHAT THIS CANNOT OBSERVE, said plainly: the harness has no layout, so it
// cannot see that the panel sits over the page without moving a region, nor
// a text selection inside the command surviving a pass. The first is the
// skin's `position: fixed`; the second is setText writing only when the text
// changed, which the "typing elsewhere" test below reaches through focus and
// value, not through a selection.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testTempRoot } from '../testSupport.ts';
import { createTicket, createWorkerProfile, listRunsForTicket } from '../store.ts';
import { knownModelIds } from '../pricing.ts';
import { withScriptedDaemon, type ScriptedDaemon } from './scriptedDaemon.ts';
import { openPage } from './domHarness.ts';
import { UI_DIR } from './page.ts';

const root = testTempRoot('ui-drilldown');
after(root.cleanup);

type OpenedPage = ReturnType<typeof openPage>;
type El = OpenedPage['document']['body'];

const SECRET = 'drill-secret-7f3a91';
const COMMAND = `export API_TOKEN=${SECRET} && pnpm test`;

// Words that are a verdict about a worker. The page measures; the owner judges.
const VERDICT = /\b(stuck|hung|hanging|stalled|frozen|wedged|unresponsive|dead)\b/i;

async function open(d: ScriptedDaemon, opts: Parameters<typeof openPage>[0] | object = {}): Promise<OpenedPage> {
  const page = openPage({ baseUrl: d.baseUrl, token: d.token, ...opts });
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

/** Every element under `node`, depth first. */
function all(node: El): El[] {
  const out: El[] = [];
  for (const c of node.children) out.push(c, ...all(c));
  return out;
}

/** The control for `ticketId` inside the element with id `region`. */
function control(page: OpenedPage, region: string, ticketId: string): El | null {
  return page.byId(region).querySelector(`[data-drill-for="${ticketId}"]`);
}

/** Every string the document holds anywhere a person or a script could read it back. */
function everyString(page: OpenedPage): string[] {
  const out: string[] = [page.document.documentElement.textContent];
  for (const e of [page.document.documentElement, ...all(page.document.documentElement)]) {
    for (const v of e.attributes.values()) out.push(v);
    out.push(e.value, e.title, e.placeholder);
  }
  return out;
}

function runningRunId(d: ScriptedDaemon, ticketId: string): string {
  const run = listRunsForTicket(d.db, ticketId).filter((r) => r.status === 'running').at(-1);
  assert.ok(run, 'sanity: the ticket has a running run');
  return run!.id;
}

/** A ticket whose worker runs COMMAND and does not finish. */
async function runningWithCommand(d: ScriptedDaemon, title = 'Run the suite'): Promise<string> {
  const t = d.addWorkTicket({ title });
  d.adapter.setLiveToolUse(t.id, { tool: 'Bash', detail: COMMAND, delayMs: 0 });
  d.adapter.setScript(t.id, { kind: 'hang' });
  await d.tickOnly();
  await d.waitForStatus(t.id, ['IN_PROGRESS'], 'IN_PROGRESS');
  const runId = runningRunId(d, t.id);
  const deadline = Date.now() + 3000;
  while (d.loop.liveRuns.get(runId)?.tool !== 'Bash' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(d.loop.liveRuns.get(runId)?.detail, COMMAND, 'sanity: the daemon holds the live command');
  return t.id;
}

async function openDrillFrom(page: OpenedPage, region: string, ticketId: string): Promise<void> {
  await pollUntil(page, () => control(page, region, ticketId) !== null, `the drill-down control in #${region}`);
  control(page, region, ticketId)!.click();
  await page.waitFor(() => !page.byId('drillLive').hidden || !page.byId('drillEnded').hidden, 'the drill-down to answer');
}

// ------------------------------------------------------- acceptance 4 ----

test('acceptance 4: the drill-down shows the tool, the command, when the tool use started and the time since progress -- and no verdict', async () => {
  await withScriptedDaemon(root, async (d) => {
    const ticketId = await runningWithCommand(d);
    const page = await open(d);
    await openDrillFrom(page, 'lanes', ticketId);

    assert.equal(page.byId('drill').hidden, false);
    assert.equal(page.text('drillTool'), 'Bash');
    assert.equal(page.text('drillCommand'), COMMAND, 'the command is shown whole and verbatim');
    assert.equal(page.byId('drillCommandRow').hidden, false);
    const since = d.loop.liveRuns.get(runningRunId(d, ticketId))!.since!;
    assert.match(page.text('drillSince'), new RegExp(`^${since.slice(11, 19)} UTC · \\d+s ago$`),
      'the start of the current tool use is the daemon\'s `since`, as a time and an elapsed measurement');
    // The fake worker used a tool and reported no progress event, so there is
    // no progress time: the page says so, and measures from the run's start.
    assert.equal(page.text('drillQuietLabel'), 'No progress yet — running for');
    assert.match(page.text('drillQuiet'), /^\d+s$/);
    assert.match(page.text('drillTitle'), /Run the suite/);

    for (const s of everyString(page)) assert.doesNotMatch(s, VERDICT, `the page states a verdict: "${s.slice(0, 120)}"`);
  });
});

test('with progress reported, the page shows the time since the last progress, from the daemon\'s lastProgressAt', async () => {
  await withScriptedDaemon(root, async (d) => {
    const t = d.addWorkTicket({ title: 'Talks, then works' });
    d.adapter.setScript(t.id, { kind: 'progress', message: 'reading the repo', delayMs: 0 });
    await d.tickOnly();
    await d.waitForStatus(t.id, ['IN_PROGRESS'], 'IN_PROGRESS');
    const runId = runningRunId(d, t.id);
    const deadline = Date.now() + 3000;
    while (!d.loop.liveRuns.get(runId)?.lastProgressAt && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));

    const page = await open(d);
    await openDrillFrom(page, 'lanes', t.id);
    assert.equal(page.text('drillQuietLabel'), 'Since the last progress');
    assert.match(page.text('drillQuiet'), /^\d+s$/);
    // No tool yet: said in words, and the rows that would be empty are gone
    // rather than drawn blank.
    assert.equal(page.text('drillTool'), 'no tool used yet');
    assert.equal(page.byId('drillCommandRow').hidden, true);
    assert.equal(page.byId('drillSinceRow').hidden, true);
  });
});

test('a worker hung before its first tool use still shows its measurement, not an empty panel', async () => {
  await withScriptedDaemon(root, async (d) => {
    const t = d.addWorkTicket({ title: 'Never starts' });
    d.adapter.setScript(t.id, { kind: 'hang' });            // no tool use, no progress, ever
    await d.tickOnly();
    await d.waitForStatus(t.id, ['IN_PROGRESS'], 'IN_PROGRESS');

    const page = await open(d);
    await openDrillFrom(page, 'lanes', t.id);
    assert.equal(page.byId('drillLive').hidden, false, 'the panel is empty for the case the owner most wants to see');
    assert.equal(page.text('drillTool'), 'no tool used yet');
    assert.equal(page.text('drillQuietLabel'), 'No progress yet — running for');
    assert.match(page.text('drillQuiet'), /^\d+s$/, 'no measurement for a worker hung at startup');
  });
});

// ------------------------------------------------------- where it lives ----

test('the control is on the running ticket\'s card and roster row, and on no ticket that is not running', async () => {
  await withScriptedDaemon(root, async (d) => {
    const profile = createWorkerProfile(d.db, { name: 'Tess', purpose: 'runs the tests', model: knownModelIds()[0]! });
    const onProfile = createTicket(d.db, {
      projectId: d.projectId, title: 'Profiled work', description: 'x', acceptanceCriteria: ['it works'],
      workspaceType: 'NONE', profile: profile.id,
    });
    d.adapter.setScript(onProfile.id, { kind: 'hang' });
    const loose = await runningWithCommand(d, 'Loose work');
    const waiting = d.addWorkTicket({ title: 'Not started' });
    await d.waitForStatus(onProfile.id, ['IN_PROGRESS'], 'the profiled ticket IN_PROGRESS');

    const page = await open(d);
    await pollUntil(page, () => control(page, 'fleetList', onProfile.id) !== null && control(page, 'fleetList', loose) !== null,
      'the controls on both roster rows');
    assert.ok(control(page, 'lanes', onProfile.id), 'the profiled running card has no control');
    assert.ok(control(page, 'lanes', loose), 'the loose running card has no control');
    assert.equal(control(page, 'lanes', waiting.id), null, 'a ticket that is not running offers a drill-down');
    assert.equal(control(page, 'fleetList', waiting.id), null);
    assert.equal(control(page, 'lanes', onProfile.id)!.getAttribute('data-drill-for'), onProfile.id,
      'the control carries the ticket id and nothing the run reported');

    control(page, 'fleetList', loose)!.click();
    await page.waitFor(() => page.text('drillCommand') === COMMAND, 'the roster row\'s control to open the drill-down');
  });
});

test('a ticket being verified (REVIEW) has the control, and it shows the VERIFIER run', async () => {
  await withScriptedDaemon(root, async (d) => {
    const t = d.addWorkTicket({ title: 'Check the parser' });
    d.adapter.setScript(t.id, { kind: 'succeed' });
    d.adapter.setScript(t.id, { kind: 'verify_hang' });
    // setLiveToolUse is keyed by ticket, so the verifier's own live channel replays it.
    d.adapter.setLiveToolUse(t.id, { tool: 'Bash', detail: 'pnpm test --verify', delayMs: 0 });
    await d.tickOnly();
    await d.waitForStatus(t.id, ['REVIEW'], 'REVIEW');

    const page = await open(d);
    await openDrillFrom(page, 'lanes', t.id);
    await pollUntil(page, () => page.text('drillCommand') === 'pnpm test --verify', 'the verifier\'s command');
    const verify = listRunsForTicket(d.db, t.id).find((r) => r.kind === 'verify' && r.status === 'running');
    assert.ok(verify, 'sanity: a verifier run is live');
    assert.ok(page.requests.includes(`/runs/${encodeURIComponent(verify!.id)}/live`), 'the page did not read the verifier run');
  });
});

// ----------------------------------------------- the run ends: a 404 ----

test('when the run ends the drill-down says so, wipes the command and stops asking', async () => {
  await withScriptedDaemon(root, async (d) => {
    const t = d.addWorkTicket({ title: 'Finishes soon' });
    d.adapter.setLiveToolUse(t.id, { tool: 'Bash', detail: COMMAND, delayMs: 0 });
    d.adapter.setScript(t.id, { kind: 'succeed', delayMs: 1500 });
    await d.tickOnly();
    await d.waitForStatus(t.id, ['IN_PROGRESS'], 'IN_PROGRESS');
    const runId = runningRunId(d, t.id);

    const page = await open(d);
    await openDrillFrom(page, 'lanes', t.id);
    await pollUntil(page, () => page.text('drillCommand') === COMMAND, 'the command on screen');

    await d.waitForStatus(t.id, ['DONE'], 'the run to settle');
    await pollUntil(page, () => !page.byId('drillEnded').hidden, 'the drill-down to say the run ended');
    assert.match(page.text('drillEnded'), /This run has ended/);
    assert.equal(page.byId('drillLive').hidden, true);
    for (const id of ['drillTool', 'drillCommand', 'drillSince', 'drillQuiet']) assert.equal(page.text(id), '', `#${id} kept a stale value`);
    for (const s of everyString(page)) assert.ok(!s.includes(SECRET), 'the command outlived its run on the page');

    const asked = page.requests.filter((p) => p.startsWith('/runs/')).length;
    await page.poll();
    await page.poll();
    assert.equal(page.requests.filter((p) => p.startsWith('/runs/')).length, asked, 'the page kept polling a dead run');
    assert.equal(page.requests.filter((p) => p === `/runs/${encodeURIComponent(runId)}/live`).length, asked);
  });
});

// ------------------------------------------- nothing is kept, anywhere ----

test('the command is never stored: no storage write, no address, and nothing in the DOM after close', async () => {
  await withScriptedDaemon(root, async (d) => {
    const ticketId = await runningWithCommand(d);
    const page = await open(d);
    const writes: string[] = [];
    for (const name of ['localStorage', 'sessionStorage'] as const) {
      const store = page.window[name] as { setItem: (k: string, v: string) => void };
      const real = store.setItem;
      store.setItem = (k, v) => { writes.push(`${name}:${k}=${v}`); real(k, v); };
    }
    const hashBefore = page.hash();

    await openDrillFrom(page, 'lanes', ticketId);
    assert.equal(page.text('drillCommand'), COMMAND);
    // While open: text only, never an attribute.
    for (const e of all(page.document.documentElement)) {
      for (const v of e.attributes.values()) assert.ok(!v.includes(SECRET), `an attribute carries the command: ${v}`);
    }
    await page.poll();

    page.byId('drillClose').click();
    await page.settle();
    assert.equal(page.byId('drill').hidden, true);
    for (const s of everyString(page)) assert.ok(!s.includes(SECRET), `the command survived the close: "${s.slice(0, 120)}"`);
    assert.deepEqual(writes.filter((w) => w.includes(SECRET)), [], 'the command was written to storage');
    assert.equal(page.hash(), hashBefore, 'the address changed');
    assert.ok(!page.hash().includes(SECRET));
    // And a poll after the close asks for nothing.
    const asked = page.requests.filter((p) => p.startsWith('/runs/')).length;
    await page.poll();
    assert.equal(page.requests.filter((p) => p.startsWith('/runs/')).length, asked, 'a closed drill-down is still polled');
  });
});

test('a live read still in flight when the panel closes draws nothing', async () => {
  await withScriptedDaemon(root, async (d) => {
    const ticketId = await runningWithCommand(d);
    const runId = runningRunId(d, ticketId);
    const page = await open(d, { delay: { path: `/runs/${encodeURIComponent(runId)}/live`, method: 'GET', ms: 300 } });

    await pollUntil(page, () => control(page, 'lanes', ticketId) !== null, 'the control');
    control(page, 'lanes', ticketId)!.click();
    // NOT page.waitFor: it settles, which would wait out the held read and
    // close after the answer had landed -- the window this test is about.
    const sentBy = Date.now() + 5000;
    while (!page.requests.includes(`/runs/${encodeURIComponent(runId)}/live`) && Date.now() < sentBy) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(page.requests.includes(`/runs/${encodeURIComponent(runId)}/live`), 'the live read was never sent');
    assert.equal(page.text('drillCommand'), '', 'sanity: the held answer has not landed yet');
    page.byId('drillClose').click();                        // while that read is held
    await new Promise((r) => setTimeout(r, 400));
    await page.settle();

    assert.equal(page.byId('drill').hidden, true);
    assert.equal(page.byId('drillLive').hidden, true, 'the late answer reopened the panel\'s live rows');
    for (const s of everyString(page)) assert.ok(!s.includes(SECRET), 'the late answer drew the command after the close');
  });
});

// Where the generation check earns its keep: with the panel closed, a late
// answer has no drill-down to write into anyway. Closed and REOPENED on
// another ticket, it would -- the first run's command would sit in the
// second ticket's panel, under the second ticket's name.
test('a live read held from one ticket never lands in the drill-down reopened on another', async () => {
  await withScriptedDaemon(root, async (d) => {
    const first = await runningWithCommand(d, 'First');
    const firstRun = runningRunId(d, first);
    const other = d.addWorkTicket({ title: 'Second' });
    d.adapter.setLiveToolUse(other.id, { tool: 'Bash', detail: 'echo second-ticket', delayMs: 0 });
    d.adapter.setScript(other.id, { kind: 'hang' });
    await d.tickOnly();
    await d.waitForStatus(other.id, ['IN_PROGRESS'], 'the second ticket IN_PROGRESS');
    const otherRun = runningRunId(d, other.id);
    const deadline = Date.now() + 3000;
    while (d.loop.liveRuns.get(otherRun)?.tool !== 'Bash' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));

    const page = await open(d, { delay: { path: `/runs/${encodeURIComponent(firstRun)}/live`, method: 'GET', ms: 400 } });
    await pollUntil(page, () => control(page, 'lanes', first) !== null && control(page, 'lanes', other.id) !== null, 'both controls');
    control(page, 'lanes', first)!.click();
    const sentBy = Date.now() + 5000;
    while (!page.requests.includes(`/runs/${encodeURIComponent(firstRun)}/live`) && Date.now() < sentBy) {
      await new Promise((r) => setTimeout(r, 5));
    }
    page.byId('drillClose').click();
    control(page, 'lanes', other.id)!.click();              // reopened while the first answer is still held
    await new Promise((r) => setTimeout(r, 500));
    await page.settle();

    assert.equal(page.text('drillCommand'), 'echo second-ticket', 'the first ticket\'s late answer took over the second\'s panel');
    for (const s of everyString(page)) assert.ok(!s.includes(SECRET), 'the first run\'s command is on screen under the second ticket');
  });
});

// ------------------------------------------------- the owner's hands ----

test('the drill-down\'s reads never disturb typing elsewhere on the page', async () => {
  await withScriptedDaemon(root, async (d) => {
    const ticketId = await runningWithCommand(d);
    const page = await open(d);
    await openDrillFrom(page, 'lanes', ticketId);

    const say = page.byId('say');
    say.value = 'half a sentence to the Man';
    say.focus();
    for (let i = 0; i < 3; i++) await page.poll();
    assert.equal(page.document.activeElement, say, 'a drill-down pass took the focus away');
    assert.equal(say.value, 'half a sentence to the Man', 'a drill-down pass touched the draft');
    assert.equal(page.text('drillCommand'), COMMAND, 'sanity: the drill-down was still being read');
  });
});

test('Close and Escape both close it, and the focus goes back to the control that opened it', async () => {
  await withScriptedDaemon(root, async (d) => {
    const ticketId = await runningWithCommand(d);
    const page = await open(d);

    await openDrillFrom(page, 'lanes', ticketId);
    assert.equal(page.document.activeElement, page.byId('drillClose'), 'opening does not move the focus into the panel');
    page.byId('drillClose').click();
    assert.equal(page.byId('drill').hidden, true);
    assert.equal(page.document.activeElement?.getAttribute('data-drill-for'), ticketId, 'the focus was not handed back');

    await openDrillFrom(page, 'lanes', ticketId);
    for (const fn of page.document.listeners.get('keydown') ?? []) fn({ key: 'Escape' });
    assert.equal(page.byId('drill').hidden, true, 'Escape does not close the drill-down');
    assert.equal(page.text('drillCommand'), '');
  });
});

test('the board\'s own re-render keeps a focused control focused', async () => {
  await withScriptedDaemon(root, async (d) => {
    const ticketId = await runningWithCommand(d);
    const page = await open(d);
    await pollUntil(page, () => control(page, 'lanes', ticketId) !== null, 'the control');
    control(page, 'lanes', ticketId)!.focus();
    await page.poll();                                      // renderBoard rebuilds every card
    const now = page.document.activeElement;
    assert.ok(now && now !== null && control(page, 'lanes', ticketId) === now,
      'the four-second board pass dropped the focused control from under the keyboard');
  });
});

// ------------------------------------------------------------ the copy ----

test('the page says once, plainly, that the command is shown live and never stored', () => {
  const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const said = html.match(/The command is shown live and never stored/g) ?? [];
  assert.equal(said.length, 1, `the sentence appears ${said.length} times`);
  assert.match(html, /<p class="drill-copy" id="drillCopy">The command is shown live and never stored: it is read from the running worker while this panel is open, and it is gone when the run ends\.<\/p>/);
  assert.doesNotMatch(html.replace(/<[^>]+>/g, ' '), VERDICT, 'the page\'s own copy states a verdict');
});
